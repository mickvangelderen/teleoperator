use crate::{Owned, Result, Session, check};
use arcore_sys as sys;
use std::ptr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PlaneFindingMode {
    Disabled = sys::AR_PLANE_FINDING_MODE_DISABLED,
    Horizontal = sys::AR_PLANE_FINDING_MODE_HORIZONTAL,
    Vertical = sys::AR_PLANE_FINDING_MODE_VERTICAL,
    HorizontalAndVertical = sys::AR_PLANE_FINDING_MODE_HORIZONTAL_AND_VERTICAL,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum LightEstimationMode {
    Disabled = sys::AR_LIGHT_ESTIMATION_MODE_DISABLED,
    AmbientIntensity = sys::AR_LIGHT_ESTIMATION_MODE_AMBIENT_INTENSITY,
    EnvironmentalHdr = sys::AR_LIGHT_ESTIMATION_MODE_ENVIRONMENTAL_HDR,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum TextureUpdateMode {
    ExternalOes = sys::AR_TEXTURE_UPDATE_MODE_BIND_TO_TEXTURE_EXTERNAL_OES,
    ExposeHardwareBuffer = sys::AR_TEXTURE_UPDATE_MODE_EXPOSE_HARDWARE_BUFFER,
}

/// An editable copy of the session's configuration. Changes take effect on apply.
pub struct Config<'s> {
    session: &'s mut Session,
    handle: Owned<sys::ArConfig>,
}

impl Session {
    pub fn config(&mut self) -> Result<Config<'_>> {
        unsafe {
            let mut config = ptr::null_mut();
            sys::ArConfig_create(self.native.ptr(), &mut config);
            let handle = Owned::new(config, sys::ArConfig_destroy, "config")?;
            sys::ArSession_getConfig(self.native.ptr(), handle.ptr());
            Ok(Config {
                session: self,
                handle,
            })
        }
    }

    /// Supplies the GL_TEXTURE_EXTERNAL_OES texture for ExternalOes mode.
    pub fn set_camera_texture_name(&mut self, texture: u32) {
        unsafe { sys::ArSession_setCameraTextureName(self.native.ptr(), texture) }
    }
}

impl Config<'_> {
    pub fn set_plane_finding_mode(&mut self, mode: PlaneFindingMode) {
        unsafe {
            sys::ArConfig_setPlaneFindingMode(
                self.session.native.ptr(),
                self.handle.ptr(),
                mode as i32,
            )
        }
    }

    pub fn set_light_estimation_mode(&mut self, mode: LightEstimationMode) {
        unsafe {
            sys::ArConfig_setLightEstimationMode(
                self.session.native.ptr(),
                self.handle.ptr(),
                mode as i32,
            )
        }
    }

    pub fn set_texture_update_mode(&mut self, mode: TextureUpdateMode) {
        unsafe {
            sys::ArConfig_setTextureUpdateMode(
                self.session.native.ptr(),
                self.handle.ptr(),
                mode as i32,
            )
        }
    }

    pub fn apply(self) -> Result<()> {
        check("ArSession_configure", unsafe {
            sys::ArSession_configure(self.session.native.ptr(), self.handle.ptr())
        })
    }
}
