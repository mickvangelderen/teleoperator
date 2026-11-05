use std::{ffi::c_void, ptr};
type Handle = *mut c_void;
#[link(name = "EGL")]
unsafe extern "C" {
    fn eglGetDisplay(native: Handle) -> Handle;
    fn eglInitialize(display: Handle, major: *mut i32, minor: *mut i32) -> u32;
    fn eglChooseConfig(
        display: Handle,
        attrs: *const i32,
        config: *mut Handle,
        size: i32,
        count: *mut i32,
    ) -> u32;
    fn eglCreateContext(
        display: Handle,
        config: Handle,
        shared: Handle,
        attrs: *const i32,
    ) -> Handle;
    fn eglCreatePbufferSurface(display: Handle, config: Handle, attrs: *const i32) -> Handle;
    fn eglMakeCurrent(display: Handle, draw: Handle, read: Handle, context: Handle) -> u32;
    fn eglDestroyContext(display: Handle, context: Handle) -> u32;
    fn eglDestroySurface(display: Handle, surface: Handle) -> u32;
    fn eglTerminate(display: Handle) -> u32;
}
pub struct Context {
    pub display: Handle,
    pub config: Handle,
    pub context: Handle,
    surface: Handle,
}
impl Context {
    pub fn new() -> Result<Self, &'static str> {
        const NONE: i32 = 0x3038;
        const SURFACE_TYPE: i32 = 0x3033;
        const PBUFFER_BIT: i32 = 1;
        const RENDERABLE_TYPE: i32 = 0x3040;
        const OPENGL_ES3_BIT: i32 = 0x40;
        const CONTEXT_CLIENT_VERSION: i32 = 0x3098;
        const WIDTH: i32 = 0x3057;
        const HEIGHT: i32 = 0x3056;
        unsafe {
            let display = eglGetDisplay(ptr::null_mut());
            if display.is_null() || eglInitialize(display, ptr::null_mut(), ptr::null_mut()) == 0 {
                return Err("EGL initialization failed");
            }
            let mut result = Self {
                display,
                config: ptr::null_mut(),
                context: ptr::null_mut(),
                surface: ptr::null_mut(),
            };
            let mut count = 0;
            if eglChooseConfig(
                display,
                [
                    SURFACE_TYPE,
                    PBUFFER_BIT,
                    RENDERABLE_TYPE,
                    OPENGL_ES3_BIT,
                    NONE,
                ]
                .as_ptr(),
                &mut result.config,
                1,
                &mut count,
            ) == 0
                || count == 0
            {
                return Err("EGL configuration unavailable");
            }
            result.context = eglCreateContext(
                display,
                result.config,
                ptr::null_mut(),
                [CONTEXT_CLIENT_VERSION, 3, NONE].as_ptr(),
            );
            result.surface = eglCreatePbufferSurface(
                display,
                result.config,
                [WIDTH, 16, HEIGHT, 16, NONE].as_ptr(),
            );
            if result.context.is_null()
                || result.surface.is_null()
                || eglMakeCurrent(display, result.surface, result.surface, result.context) == 0
            {
                return Err("EGL context creation failed");
            }
            Ok(result)
        }
    }
}
impl Drop for Context {
    fn drop(&mut self) {
        unsafe {
            eglMakeCurrent(
                self.display,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if !self.surface.is_null() {
                eglDestroySurface(self.display, self.surface);
            }
            if !self.context.is_null() {
                eglDestroyContext(self.display, self.context);
            }
            eglTerminate(self.display);
        }
    }
}
