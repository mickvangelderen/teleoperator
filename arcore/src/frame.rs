use crate::{Error, Owned, Pose, Result, Session, TrackingState, check};
use arcore_sys as sys;
use std::{mem::MaybeUninit, ptr};

/// The current frame. Reading it borrows the session, preventing another update.
pub struct Frame<'s> {
    pub(crate) session: &'s Session,
}

impl Frame<'_> {
    /// Image capture time in nanoseconds. ARCore does not specify its time base.
    pub fn timestamp_ns(&self) -> i64 {
        let mut ns = 0;
        unsafe {
            sys::ArFrame_getTimestamp(self.session.native.ptr(), self.session.frame.ptr(), &mut ns)
        };
        ns
    }

    /// Camera2 SENSOR_TIMESTAMP for this image. Missing metadata or a missing tag
    /// yields None, including during camera startup.
    pub fn android_camera_timestamp_ns(&self) -> Result<Option<i64>> {
        unsafe {
            let session = self.session.native.ptr();
            let mut metadata = ptr::null_mut();
            let status =
                sys::ArFrame_acquireImageMetadata(session, self.session.frame.ptr(), &mut metadata);
            if status == sys::AR_ERROR_NOT_YET_AVAILABLE {
                return Ok(None);
            }
            check("ArFrame_acquireImageMetadata", status)?;
            let metadata = Owned::new(metadata, sys::ArImageMetadata_release, "image metadata")?;
            let mut entry = MaybeUninit::uninit();
            let status = sys::ArImageMetadata_getConstEntry(
                session,
                metadata.ptr(),
                sys::ANDROID_SENSOR_TIMESTAMP_TAG,
                entry.as_mut_ptr(),
            );
            if status == sys::AR_ERROR_METADATA_NOT_FOUND {
                return Ok(None);
            }
            check("ArImageMetadata_getConstEntry", status)?;
            // On success the SDK initialized the entry. Its type selects the
            // union member, and the pointed-to storage lives with metadata.
            let entry = entry.assume_init();
            if entry.tag != sys::ANDROID_SENSOR_TIMESTAMP_TAG
                || entry.type_ != sys::ANDROID_METADATA_INT64
                || entry.count != 1
                || entry.data.i64_.is_null()
            {
                return Err(Error::InvalidCameraTimestamp);
            }
            Ok(Some(*entry.data.i64_))
        }
    }

    pub fn tracking_state(&self) -> Result<TrackingState> {
        self.tracking_status().map(|(state, _)| state)
    }

    /// The SDK supplies an actionable failure reason while camera tracking is paused.
    pub fn tracking_status(&self) -> Result<(TrackingState, sys::ArTrackingFailureReason)> {
        unsafe {
            let session = self.session.native.ptr();
            let mut camera = ptr::null_mut();
            sys::ArFrame_acquireCamera(session, self.session.frame.ptr(), &mut camera);
            let camera = Owned::new(camera, sys::ArCamera_release, "camera")?;
            let mut state = 0;
            sys::ArCamera_getTrackingState(session, camera.ptr(), &mut state);
            let state = TrackingState::from(state);
            let mut reason = sys::AR_TRACKING_FAILURE_REASON_NONE as sys::ArTrackingFailureReason;
            if state == TrackingState::Paused {
                sys::ArCamera_getTrackingFailureReason(session, camera.ptr(), &mut reason);
            }
            Ok((state, reason))
        }
    }

    /// The Android sensor coordinate system in world space, independent of display
    /// rotation. The pose is meaningful while the camera is tracking.
    pub fn android_sensor_pose(&self) -> Pose {
        self.session.native.read_pose(|out| unsafe {
            sys::ArFrame_getAndroidSensorPose(
                self.session.native.ptr(),
                self.session.frame.ptr(),
                out,
            )
        })
    }
}
