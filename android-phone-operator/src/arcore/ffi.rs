//! Narrow hand-written ABI declarations checked against official ARCore 1.57.0
//! arcore_c_api.h; pinned archive/header provenance in tools/build-arcore-apk.sh.
#![allow(non_snake_case)]
use std::ffi::{c_char, c_void};
macro_rules! opaque { ($($name:ident),*) => { $(#[repr(C)] pub struct $name { _private: [u8;0] })* }; }
opaque!(
    ArSession,
    ArConfig,
    ArFrame,
    ArPose,
    ArAnchor,
    ArCamera,
    ArCameraConfig,
    ArImageMetadata
);
// ArImageMetadata_const_entry: uint32 tag; uint8 type; uint32 count; pointer union.
#[repr(C)]
#[derive(Default)]
pub struct MetadataEntry {
    pub tag: u32,
    pub kind: u8,
    pub count: u32,
    pub data: *const c_void,
}
pub const ACAMERA_SENSOR_TIMESTAMP: u32 = (14 << 16) + 16;
#[link(name = "arcore_sdk_c")]
unsafe extern "C" {
    pub fn ArCoreApk_checkAvailability(env: *mut c_void, context: *mut c_void, out: *mut i32);
    pub fn ArCoreApk_requestInstall(
        env: *mut c_void,
        activity: *mut c_void,
        requested: i32,
        out: *mut i32,
    ) -> i32;
    pub fn ArSession_create(
        env: *mut c_void,
        context: *mut c_void,
        out: *mut *mut ArSession,
    ) -> i32;
    pub fn ArSession_destroy(s: *mut ArSession);
    pub fn ArSession_resume(s: *mut ArSession) -> i32;
    pub fn ArSession_pause(s: *mut ArSession) -> i32;
    pub fn ArSession_update(s: *mut ArSession, f: *mut ArFrame) -> i32;
    pub fn ArSession_configure(s: *const ArSession, c: *const ArConfig) -> i32;
    pub fn ArSession_setCameraTextureName(s: *mut ArSession, texture: u32);
    pub fn ArSession_setDisplayGeometry(s: *mut ArSession, rotation: i32, width: i32, height: i32);
    pub fn ArSession_getCameraConfig(s: *const ArSession, c: *mut ArCameraConfig);
    pub fn ArSession_acquireNewAnchor(
        s: *mut ArSession,
        p: *const ArPose,
        a: *mut *mut ArAnchor,
    ) -> i32;
    pub fn ArConfig_create(s: *const ArSession, c: *mut *mut ArConfig);
    pub fn ArConfig_destroy(c: *mut ArConfig);
    pub fn ArConfig_setPlaneFindingMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setLightEstimationMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setDepthMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setInstantPlacementMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setCloudAnchorMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setGeospatialMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setSemanticMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setImageStabilizationMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setUpdateMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArConfig_setTextureUpdateMode(s: *const ArSession, c: *mut ArConfig, v: i32);
    pub fn ArFrame_create(s: *const ArSession, f: *mut *mut ArFrame);
    pub fn ArFrame_destroy(f: *mut ArFrame);
    pub fn ArFrame_getTimestamp(s: *const ArSession, f: *const ArFrame, t: *mut i64);
    pub fn ArFrame_getAndroidSensorPose(s: *const ArSession, f: *const ArFrame, p: *mut ArPose);
    pub fn ArFrame_acquireCamera(s: *const ArSession, f: *const ArFrame, c: *mut *mut ArCamera);
    pub fn ArFrame_acquireImageMetadata(
        s: *const ArSession,
        f: *const ArFrame,
        m: *mut *mut ArImageMetadata,
    ) -> i32;
    pub fn ArCamera_getTrackingState(s: *const ArSession, c: *const ArCamera, state: *mut i32);
    pub fn ArCamera_getTrackingFailureReason(
        s: *const ArSession,
        c: *const ArCamera,
        reason: *mut i32,
    );
    pub fn ArCamera_release(c: *mut ArCamera);
    pub fn ArCameraConfig_create(s: *const ArSession, c: *mut *mut ArCameraConfig);
    pub fn ArCameraConfig_destroy(c: *mut ArCameraConfig);
    pub fn ArCameraConfig_getCameraId(
        s: *const ArSession,
        c: *const ArCameraConfig,
        id: *mut *mut c_char,
    );
    pub fn ArString_release(s: *mut c_char);
    pub fn ArPose_create(s: *const ArSession, raw: *const f32, p: *mut *mut ArPose);
    pub fn ArPose_destroy(p: *mut ArPose);
    pub fn ArPose_getPoseRaw(s: *const ArSession, p: *const ArPose, out: *mut f32);
    pub fn ArAnchor_getTrackingState(s: *const ArSession, a: *const ArAnchor, state: *mut i32);
    pub fn ArAnchor_getPose(s: *const ArSession, a: *const ArAnchor, p: *mut ArPose);
    pub fn ArAnchor_detach(s: *mut ArSession, a: *mut ArAnchor);
    pub fn ArAnchor_release(a: *mut ArAnchor);
    pub fn ArImageMetadata_getConstEntry(
        s: *const ArSession,
        m: *const ArImageMetadata,
        tag: u32,
        entry: *mut MetadataEntry,
    ) -> i32;
    pub fn ArImageMetadata_release(m: *mut ArImageMetadata);
}
pub const EGL_NONE: i32 = 0x3038;
pub const EGL_SURFACE_TYPE: i32 = 0x3033;
pub const EGL_PBUFFER_BIT: i32 = 1;
pub const EGL_RENDERABLE_TYPE: i32 = 0x3040;
pub const EGL_OPENGL_ES2_BIT: i32 = 4;
pub const EGL_RED_SIZE: i32 = 0x3024;
pub const EGL_GREEN_SIZE: i32 = 0x3023;
pub const EGL_BLUE_SIZE: i32 = 0x3022;
pub const EGL_CONTEXT_CLIENT_VERSION: i32 = 0x3098;
pub const EGL_WIDTH: i32 = 0x3057;
pub const EGL_HEIGHT: i32 = 0x3056;
pub const EGL_OPENGL_ES_API: u32 = 0x30a0;
pub const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8d65;
pub const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
pub const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
pub const GL_TEXTURE_WRAP_S: u32 = 0x2802;
pub const GL_TEXTURE_WRAP_T: u32 = 0x2803;
pub const GL_LINEAR: i32 = 0x2601;
pub const GL_CLAMP_TO_EDGE: i32 = 0x812f;
#[link(name = "EGL")]
unsafe extern "C" {
    pub fn eglGetDisplay(native: *mut c_void) -> *mut c_void;
    pub fn eglInitialize(d: *mut c_void, major: *mut i32, minor: *mut i32) -> u32;
    pub fn eglBindAPI(api: u32) -> u32;
    pub fn eglChooseConfig(
        d: *mut c_void,
        attrs: *const i32,
        configs: *mut *mut c_void,
        size: i32,
        n: *mut i32,
    ) -> u32;
    pub fn eglCreateContext(
        d: *mut c_void,
        c: *mut c_void,
        shared: *mut c_void,
        attrs: *const i32,
    ) -> *mut c_void;
    pub fn eglCreatePbufferSurface(
        d: *mut c_void,
        c: *mut c_void,
        attrs: *const i32,
    ) -> *mut c_void;
    pub fn eglMakeCurrent(
        d: *mut c_void,
        draw: *mut c_void,
        read: *mut c_void,
        ctx: *mut c_void,
    ) -> u32;
    pub fn eglDestroySurface(d: *mut c_void, s: *mut c_void) -> u32;
    pub fn eglDestroyContext(d: *mut c_void, c: *mut c_void) -> u32;
    pub fn eglTerminate(d: *mut c_void) -> u32;
    pub fn eglReleaseThread() -> u32;
}
#[link(name = "GLESv2")]
unsafe extern "C" {
    pub fn glGenTextures(n: i32, textures: *mut u32);
    pub fn glBindTexture(target: u32, texture: u32);
    pub fn glTexParameteri(target: u32, name: u32, value: i32);
    pub fn glGetError() -> u32;
    pub fn glDeleteTextures(n: i32, textures: *const u32);
}
