//! Android ARCore session tracking. Create and use a session on one thread.
//! Call the ARCore availability/install API and obtain camera permission before
//! creating a session. Session destruction can block for several seconds.

mod camera_config;
mod config;
mod frame;

pub use config::{Config, LightEstimationMode, PlaneFindingMode, TextureUpdateMode};
pub use frame::Frame;

use arcore_sys as sys;
use jni::{JNIEnv, objects::JObject};
use std::{
    fmt,
    ptr::{self, NonNull},
    rc::Rc,
};

#[derive(Debug)]
pub enum Error {
    /// The original signed ArStatus from the named SDK operation.
    Status(&'static str, i32),
    MissingHandle(&'static str),
    InvalidContext,
    Jni(jni::errors::Error),
    InvalidCameraTimestamp,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status(operation, status) => {
                write!(f, "{operation} returned ARCore status {status}")
            }
            Self::MissingHandle(name) => write!(f, "ARCore returned a null {name}"),
            Self::InvalidContext => f.write_str("Expected an Android Context"),
            Self::Jni(error) => error.fmt(f),
            Self::InvalidCameraTimestamp => f.write_str("Invalid camera sensor timestamp metadata"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

fn check(operation: &'static str, status: sys::ArStatus) -> Result<()> {
    if status == sys::AR_SUCCESS {
        Ok(())
    } else {
        Err(Error::Status(operation, status))
    }
}

// Each acquired handle is paired with its specific C destructor immediately,
// including temporaries on paths where the next SDK call can fail.
struct Owned<T> {
    ptr: NonNull<T>,
    release: unsafe extern "C" fn(*mut T),
}

impl<T> Owned<T> {
    // SAFETY: ptr is null or a uniquely owned acquisition released by release.
    unsafe fn new(
        ptr: *mut T,
        release: unsafe extern "C" fn(*mut T),
        name: &'static str,
    ) -> Result<Self> {
        Ok(Self {
            ptr: NonNull::new(ptr).ok_or(Error::MissingHandle(name))?,
            release,
        })
    }

    fn ptr(&self) -> *mut T {
        self.ptr.as_ptr()
    }
}

impl<T> Drop for Owned<T> {
    fn drop(&mut self) {
        unsafe { (self.release)(self.ptr()) }
    }
}

/// The native world-space rotation (x, y, z, w) and translation in meters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub rotation: [f32; 4],
    pub translation: [f32; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackingState {
    Tracking,
    Paused,
    Stopped,
    Unknown(i32),
}

impl From<sys::ArTrackingState> for TrackingState {
    fn from(state: sys::ArTrackingState) -> Self {
        match state as u32 {
            sys::AR_TRACKING_STATE_TRACKING => Self::Tracking,
            sys::AR_TRACKING_STATE_PAUSED => Self::Paused,
            sys::AR_TRACKING_STATE_STOPPED => Self::Stopped,
            _ => Self::Unknown(state),
        }
    }
}

// Session and anchors share a thread-confined native owner. A scratch pose
// is overwritten and copied in a single synchronous call. Field order keeps
// the native session alive through scratch destruction.
struct NativeSession {
    scratch: Owned<sys::ArPose>,
    handle: Owned<sys::ArSession>,
}

impl NativeSession {
    fn ptr(&self) -> *mut sys::ArSession {
        self.handle.ptr()
    }

    fn read_pose(&self, fill: impl FnOnce(*mut sys::ArPose)) -> Pose {
        fill(self.scratch.ptr());
        let mut raw = [0.0; 7];
        unsafe { sys::ArPose_getPoseRaw(self.ptr(), self.scratch.ptr(), raw.as_mut_ptr()) };
        let [x, y, z, w, tx, ty, tz] = raw;
        Pose {
            rotation: [x, y, z, w],
            translation: [tx, ty, tz],
        }
    }
}

/// Owns the update loop and pauses a running session on drop. Anchors retain
/// the native session until their final detach/release.
pub struct Session {
    frame: Owned<sys::ArFrame>,
    native: Rc<NativeSession>,
    resumed: bool,
}

impl Session {
    /// Creates a paused session using a local or global Android Context reference.
    pub fn new(env: &mut JNIEnv<'_>, context: &JObject<'_>) -> Result<Self> {
        if context.is_null()
            || !env
                .is_instance_of(context, "android/content/Context")
                .map_err(Error::Jni)?
        {
            return Err(Error::InvalidContext);
        }
        unsafe {
            let mut session = ptr::null_mut();
            check(
                "ArSession_create",
                sys::ArSession_create(env.get_raw().cast(), context.as_raw().cast(), &mut session),
            )?;
            let handle = Owned::new(session, sys::ArSession_destroy, "session")?;
            let mut scratch = ptr::null_mut();
            sys::ArPose_create(session, ptr::null(), &mut scratch);
            let scratch = Owned::new(scratch, sys::ArPose_destroy, "pose")?;
            let mut frame = ptr::null_mut();
            sys::ArFrame_create(session, &mut frame);
            Ok(Self {
                frame: Owned::new(frame, sys::ArFrame_destroy, "frame")?,
                native: Rc::new(NativeSession { scratch, handle }),
                resumed: false,
            })
        }
    }

    pub fn resume(&mut self) -> Result<()> {
        check("ArSession_resume", unsafe {
            sys::ArSession_resume(self.native.ptr())
        })?;
        self.resumed = true;
        Ok(())
    }

    pub fn pause(&mut self) -> Result<()> {
        check("ArSession_pause", unsafe {
            sys::ArSession_pause(self.native.ptr())
        })?;
        self.resumed = false;
        Ok(())
    }

    /// Reuses the native frame. The returned view borrows this update until
    /// the caller finishes reading it.
    pub fn update(&mut self) -> Result<Frame<'_>> {
        check("ArSession_update", unsafe {
            sys::ArSession_update(self.native.ptr(), self.frame.ptr())
        })?;
        Ok(Frame { session: self })
    }

    /// Creates an independently owned anchor at a world-space pose.
    pub fn create_anchor(&self, pose: Pose) -> Result<Anchor> {
        let [x, y, z, w] = pose.rotation;
        let [tx, ty, tz] = pose.translation;
        let raw = [x, y, z, w, tx, ty, tz];
        unsafe {
            let session = self.native.ptr();
            let mut pose = ptr::null_mut();
            sys::ArPose_create(session, raw.as_ptr(), &mut pose);
            let pose = Owned::new(pose, sys::ArPose_destroy, "pose")?;
            let mut anchor = ptr::null_mut();
            check(
                "ArSession_acquireNewAnchor",
                sys::ArSession_acquireNewAnchor(session, pose.ptr(), &mut anchor),
            )?;
            Ok(Anchor {
                handle: Owned::new(anchor, sys::ArAnchor_release, "anchor")?,
                session: self.native.clone(),
            })
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.resumed {
            let _ = self.pause();
        }
    }
}

/// Stays valid across updates. Dropping the anchor detaches it and releases its reference.
pub struct Anchor {
    handle: Owned<sys::ArAnchor>,
    session: Rc<NativeSession>,
}

impl Anchor {
    pub fn tracking_state(&self) -> TrackingState {
        let mut state = 0;
        unsafe {
            sys::ArAnchor_getTrackingState(self.session.ptr(), self.handle.ptr(), &mut state)
        };
        state.into()
    }

    /// World-space pose, meaningful while the anchor is tracking.
    pub fn pose(&self) -> Pose {
        self.session.read_pose(|out| unsafe {
            sys::ArAnchor_getPose(self.session.ptr(), self.handle.ptr(), out)
        })
    }
}

impl Drop for Anchor {
    fn drop(&mut self) {
        unsafe { sys::ArAnchor_detach(self.session.ptr(), self.handle.ptr()) }
    }
}
