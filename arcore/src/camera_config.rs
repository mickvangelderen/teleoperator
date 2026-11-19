//! Camera configuration for clients that track poses without displaying a preview.
use crate::{Owned, Result, Session, check};
use arcore_sys as sys;
use std::{ffi::CStr, ptr};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Capture {
    camera_id: String,
    cpu_image: [i32; 2],
    fps: [i32; 2],
    facing: i32,
    depth: u32,
    stereo: i32,
}

struct CameraConfig {
    capture: Capture,
    texture: [i32; 2],
}

impl CameraConfig {
    fn smaller_preview_than(&self, other: &Self) -> bool {
        let pixels = |[w, h]: [i32; 2]| i64::from(w) * i64::from(h);
        self.capture == other.capture
            && self.texture.iter().all(|&dimension| dimension > 0)
            && pixels(self.texture) < pixels(other.texture)
    }
}

impl Session {
    fn camera_config_handle(&self) -> Result<Owned<sys::ArCameraConfig>> {
        unsafe {
            let mut config = ptr::null_mut();
            sys::ArCameraConfig_create(self.native.ptr(), &mut config);
            Owned::new(config, sys::ArCameraConfig_destroy, "camera config")
        }
    }

    fn config_camera_id(&self, config: &Owned<sys::ArCameraConfig>) -> Result<String> {
        unsafe {
            let mut id = ptr::null_mut();
            sys::ArCameraConfig_getCameraId(self.native.ptr(), config.ptr(), &mut id);
            let id = Owned::new(id, sys::ArString_release, "camera ID")?;
            Ok(CStr::from_ptr(id.ptr()).to_string_lossy().into_owned())
        }
    }

    /// Gets the Camera2 ID selected by the current ARCore camera configuration.
    pub fn camera_id(&self) -> Result<String> {
        let config = self.camera_config_handle()?;
        unsafe { sys::ArSession_getCameraConfig(self.native.ptr(), config.ptr()) };
        self.config_camera_id(&config)
    }

    fn describe_camera(&self, config: &Owned<sys::ArCameraConfig>) -> Result<CameraConfig> {
        let session = self.native.ptr();
        let camera = config.ptr();
        let (mut width, mut height, mut min_fps, mut max_fps) = (0, 0, 0, 0);
        let (mut texture_width, mut texture_height) = (0, 0);
        let (mut facing, mut depth, mut stereo) = (0, 0, 0);
        unsafe {
            sys::ArCameraConfig_getImageDimensions(session, camera, &mut width, &mut height);
            sys::ArCameraConfig_getFpsRange(session, camera, &mut min_fps, &mut max_fps);
            sys::ArCameraConfig_getFacingDirection(session, camera, &mut facing);
            sys::ArCameraConfig_getDepthSensorUsage(session, camera, &mut depth);
            sys::ArCameraConfig_getStereoCameraUsage(session, camera, &mut stereo);
            sys::ArCameraConfig_getTextureDimensions(
                session,
                camera,
                &mut texture_width,
                &mut texture_height,
            );
        }
        Ok(CameraConfig {
            capture: Capture {
                camera_id: self.config_camera_id(config)?,
                cpu_image: [width, height],
                fps: [min_fps, max_fps],
                facing,
                depth,
                stereo,
            },
            texture: [texture_width, texture_height],
        })
    }

    /// On a new, paused session, select the smallest advertised preview with the
    /// same camera, tracking inputs and frame-rate range. Returns whether it changed.
    pub fn prefer_small_preview(&mut self) -> Result<bool> {
        let session = self.native.ptr();
        let config = self.camera_config_handle()?;
        unsafe {
            sys::ArSession_getCameraConfig(session, config.ptr());
            let mut best = self.describe_camera(&config)?;
            // A null filter omits the SDK's alternative preview resolutions.
            let mut filter = ptr::null_mut();
            sys::ArCameraConfigFilter_create(session, &mut filter);
            let filter = Owned::new(
                filter,
                sys::ArCameraConfigFilter_destroy,
                "camera config filter",
            )?;
            sys::ArCameraConfigFilter_setFacingDirection(
                session,
                filter.ptr(),
                best.capture.facing,
            );
            let mut list = ptr::null_mut();
            sys::ArCameraConfigList_create(session, &mut list);
            let list = Owned::new(list, sys::ArCameraConfigList_destroy, "camera config list")?;
            sys::ArSession_getSupportedCameraConfigsWithFilter(session, filter.ptr(), list.ptr());
            let mut count = 0;
            sys::ArCameraConfigList_getSize(session, list.ptr(), &mut count);
            let mut selected = None;
            for index in 0..count {
                sys::ArCameraConfigList_getItem(session, list.ptr(), index, config.ptr());
                let candidate = self.describe_camera(&config)?;
                if candidate.smaller_preview_than(&best) {
                    best = candidate;
                    selected = Some(index);
                }
            }
            let Some(index) = selected else {
                return Ok(false);
            };
            sys::ArCameraConfigList_getItem(session, list.ptr(), index, config.ptr());
            check(
                "ArSession_setCameraConfig",
                sys::ArSession_setCameraConfig(session, config.ptr()),
            )?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smaller_preview_preserves_every_capture_property() {
        let capture = Capture {
            camera_id: "0".into(),
            cpu_image: [640, 480],
            fps: [30, 30],
            facing: 0,
            depth: 2,
            stereo: 2,
        };
        let default = CameraConfig {
            capture: capture.clone(),
            texture: [1920, 1080],
        };
        let small = |capture| CameraConfig {
            capture,
            texture: [640, 480],
        };
        assert!(small(capture.clone()).smaller_preview_than(&default));
        assert!(!default.smaller_preview_than(&default));
        assert!(!default.smaller_preview_than(&small(capture.clone())));
        assert!(
            !CameraConfig {
                capture: capture.clone(),
                texture: [0, 480]
            }
            .smaller_preview_than(&default)
        );
        for changed in [
            Capture {
                camera_id: "1".into(),
                ..capture.clone()
            },
            Capture {
                cpu_image: [1280, 720],
                ..capture.clone()
            },
            Capture {
                fps: [15, 30],
                ..capture.clone()
            },
            Capture {
                facing: 1,
                ..capture.clone()
            },
            Capture {
                depth: 1,
                ..capture.clone()
            },
            Capture {
                stereo: 1,
                ..capture
            },
        ] {
            assert!(!small(changed).smaller_preview_than(&default));
        }
    }
}
