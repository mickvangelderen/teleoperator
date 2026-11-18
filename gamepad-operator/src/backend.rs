//! Linux-only SDL evdev input. No video, keyboard, mouse, haptics, or HIDAPI.
//! SDL 2 mappings: https://wiki.libsdl.org/SDL2/CategoryGameController
use crate::input::{Definition, DeviceInfo, Hub, InputValue, OBSERVATION_PERIOD_NS, Source};
use sdl2::{
    controller::{Axis, Button, GameController},
    event::Event,
    joystick::Joystick,
};
use serde::Serialize;
use std::{
    ffi::CStr,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub fn axis(v: i16) -> f64 {
    if v < 0 {
        v as f64 / 32768.
    } else {
        v as f64 / 32767.
    }
}
pub fn trigger(v: i16) -> f64 {
    f64::from(v.max(0)) / 32767.
}
#[derive(Clone, Debug, Serialize)]
pub struct InventoryItem {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Kernel input-device uniq; USB HID may copy a receiver serial here.
    pub uniq: Option<String>,
    pub usb_serial: Option<String>,
    pub input_slot: String,
    pub reconnectable: bool,
    pub vendor: String,
    pub product: String,
    pub eligible: bool,
    pub diagnostic: String,
}
/// Accept only nonzero MAC-shaped input uniq values for reconnect eligibility.
/// USB HID otherwise copies iSerialNumber into uniq, possibly from a receiver:
/// https://github.com/torvalds/linux/blob/master/drivers/hid/usbhid/hid-core.c
/// This is a driver identity heuristic, not authentication of physical hardware.
fn mac_shaped_uniq(value: &str) -> bool {
    value.len() == 17
        && value
            .split(':')
            .all(|octet| octet.len() == 2 && octet.bytes().all(|b| b.is_ascii_hexdigit()))
        && value.bytes().any(|b| b != b'0' && b != b':')
}
/// Without eligible input uniq, identity is scoped to the current input slot. Including
/// both phys and the canonical input path disambiguates receiver slots even when
/// their receiver serial and phys match. These IDs may change after reconnect.
fn identity(
    vendor: &str,
    product: &str,
    uniq: Option<&str>,
    usb_serial: Option<&str>,
    phys: &str,
    input_slot: &str,
) -> (String, bool) {
    if let Some(uniq) = uniq.filter(|s| mac_shaped_uniq(s)) {
        // Canonicalize case so two spellings of the same address still collide.
        (
            format!("uniq:{vendor}:{product}:{}", uniq.to_ascii_lowercase()),
            true,
        )
    } else {
        let location = format!("{phys}:{input_slot}");
        let id = format!(
            "slot:{vendor}:{product}:{}:{}:{location}",
            uniq.unwrap_or(""),
            usb_serial.unwrap_or("")
        );
        (id, false)
    }
}
fn read(path: &Path, name: &str) -> String {
    fs::read_to_string(path.join(name))
        .unwrap_or_default()
        .trim()
        .to_string()
}
fn has_bit(bitmap: &str, bit: usize) -> bool {
    bitmap
        .split_whitespace()
        .rev()
        .nth(bit / 64)
        .and_then(|n| u64::from_str_radix(n, 16).ok())
        .is_some_and(|n| n & (1u64 << (bit % 64)) != 0)
}
/// Metadata only: reject keyboard, mouse, digitizer and ambiguous composite nodes
/// before selecting a joystick for event reads. SDL discovery can open other
/// event nodes for metadata ioctls; those opens do not read input events.
fn gamepad_keys(keys: &str, abs: &str, rel: &str) -> bool {
    let positional =
        (has_bit(abs, 0) && has_bit(abs, 1)) || (has_bit(abs, 0x10) && has_bit(abs, 0x11));
    let game = (0x120..0x140).any(|b| has_bit(keys, b))
        || (positional && (0x100..0x110).any(|b| has_bit(keys, b)));
    // Linux xpad exposes Xbox Series Share as KEY_RECORD (167), alongside
    // ordinary gamepad buttons. Known auxiliary keys are safe only on a node
    // with the standard gamepad/joystick button range AND both stick axes.
    // https://github.com/torvalds/linux/blob/master/drivers/input/joystick/xpad.c
    let auxiliary_keys =
        (0x120..0x140).any(|b| has_bit(keys, b)) && has_bit(abs, 0) && has_bit(abs, 1);
    let keyboard = (1..0x100)
        .any(|b| has_bit(keys, b) && !(auxiliary_keys && [139, 158, 167, 172].contains(&b)));
    let mouse = (0x110..0x118).any(|b| has_bit(keys, b));
    let digitizer = (0x140..=0x14f).any(|b| has_bit(keys, b));
    game && !keyboard && !mouse && !digitizer && !has_bit(rel, 0) && !has_bit(rel, 1)
}
pub fn inventory() -> Result<Vec<InventoryItem>, String> {
    if !cfg!(target_os = "linux") {
        return Err("Physical backend currently supports Linux evdev only; use --synthetic on this platform".into());
    }
    let entries = fs::read_dir("/sys/class/input")
        .map_err(|e| format!("Cannot inspect Linux input metadata: {e}"))?;
    let mut out = vec![];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("event") {
            continue;
        }
        let base = entry.path().join("device");
        let keys = read(&base, "capabilities/key");
        let abs = read(&base, "capabilities/abs");
        let rel = read(&base, "capabilities/rel");
        let eligible = gamepad_keys(&keys, &abs, &rel);
        // Report potential joystick interfaces only; never collect other input values.
        if !eligible && !(has_bit(&abs, 0x10) && has_bit(&abs, 0x11)) {
            continue;
        }
        let vendor = read(&base, "id/vendor");
        let product = read(&base, "id/product");
        let uniq = read(&base, "uniq");
        let uniq = (!uniq.is_empty()).then_some(uniq);
        let canonical = fs::canonicalize(&base).unwrap_or(base.clone());
        // The closest USB device can be a receiver. Its serial is diagnostic,
        // never evidence that the input device is a particular physical pad.
        let usb_serial = canonical
            .ancestors()
            .find(|parent| {
                !read(parent, "idVendor").is_empty() && !read(parent, "idProduct").is_empty()
            })
            .and_then(|parent| {
                let serial = read(parent, "serial");
                (!serial.is_empty()).then_some(serial)
            });
        let input_slot = canonical.display().to_string();
        let phys = read(&base, "phys");
        let (id, reconnectable) = identity(
            &vendor,
            &product,
            uniq.as_deref(),
            usb_serial.as_deref(),
            &phys,
            &input_slot,
        );
        out.push(InventoryItem {
            id,name:read(&base,"name"),path:format!("/dev/input/{name}"),uniq,usb_serial,input_slot,reconnectable,vendor,product,eligible,
            diagnostic:if eligible {"Gamepad-only interface; SDL mapping and access checked on selection"}else{"Excluded: not a gamepad-only interface (keyboard/mouse/digitizer or missing gamepad controls)"}.into()
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub struct Sdl {
    _context: sdl2::Sdl,
    events: sdl2::EventPump,
    joysticks: sdl2::JoystickSubsystem,
    controllers: sdl2::GameControllerSubsystem,
}
impl Sdl {
    pub fn new(mapping: Option<&Path>) -> Result<Self, String> {
        if !cfg!(target_os = "linux") {
            return Err("Physical input is qualified only on Linux".into());
        }
        // Override per-driver hints too: HID initialization may send device outputs.
        for key in [
            "SDL_JOYSTICK_HIDAPI",
            "SDL_JOYSTICK_HIDAPI_PS3",
            "SDL_JOYSTICK_HIDAPI_PS4",
            "SDL_JOYSTICK_HIDAPI_PS5",
            "SDL_JOYSTICK_HIDAPI_XBOX",
            "SDL_JOYSTICK_HIDAPI_XBOX_360",
            "SDL_JOYSTICK_HIDAPI_XBOX_ONE",
            "SDL_JOYSTICK_HIDAPI_XBOX_360_WIRELESS",
            "SDL_JOYSTICK_HIDAPI_WII",
            "SDL_JOYSTICK_HIDAPI_SWITCH",
            "SDL_JOYSTICK_HIDAPI_JOY_CONS",
            "SDL_JOYSTICK_HIDAPI_GAMECUBE",
            "SDL_JOYSTICK_HIDAPI_LUNA",
            "SDL_JOYSTICK_HIDAPI_NINTENDO_CLASSIC",
            "SDL_JOYSTICK_HIDAPI_SHIELD",
            "SDL_JOYSTICK_HIDAPI_STADIA",
            "SDL_JOYSTICK_HIDAPI_STEAM",
            "SDL_ENABLE_STEAM_CONTROLLERS",
            "SDL_LINUX_JOYSTICK_CLASSIC",
            "SDL_LINUX_JOYSTICK_DEADZONES",
            "SDL_LINUX_HAT_DEADZONES",
            "SDL_GAMECONTROLLER_USE_BUTTON_LABELS",
        ] {
            sdl2::hint::set_with_priority(key, "0", &sdl2::hint::Hint::Override);
        }
        sdl2::hint::set_with_priority(
            "SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS",
            "1",
            &sdl2::hint::Hint::Override,
        );
        let context = sdl2::init()?;
        let joysticks = context.joystick()?;
        let controllers = context.game_controller()?;
        if let Some(path) = mapping {
            controllers.load_mappings(path).map_err(|e| e.to_string())?;
        }
        let events = context.event_pump()?;
        Ok(Self {
            _context: context,
            events,
            joysticks,
            controllers,
        })
    }
    fn index_for_path(&self, path: &str) -> Result<Option<u32>, String> {
        for index in 0..self.joysticks.num_joysticks()? {
            // SDL owns a NUL-terminated path for this device index until inventory changes.
            let ptr = unsafe { sdl2::sys::SDL_JoystickPathForIndex(index as i32) };
            if !ptr.is_null() && unsafe { CStr::from_ptr(ptr) }.to_string_lossy() == path {
                return Ok(Some(index));
            }
        }
        Ok(None)
    }
    pub fn list(&mut self) -> Result<Vec<InventoryItem>, String> {
        self.events.pump_events();
        let mut items = inventory()?;
        for item in &mut items {
            if item.eligible {
                item.diagnostic=match self.index_for_path(&item.path)? {
                Some(i)=>if self.controllers.is_game_controller(i){"SDL mapped controller"}else{"Unmapped: raw button/axis/hat indices; no assumed layout"}.into(),
                None=>"Not visible to SDL: check current user read access to this gamepad node/session ACL and kernel gamepad driver; no permissions changed".into()
            };
            }
        }
        Ok(items)
    }
    fn open(&mut self, item: &InventoryItem) -> Result<Opened, String> {
        // Re-read classification immediately before opening. No arbitrary event path CLI.
        let current = inventory()?
            .into_iter()
            .find(|d| d.path == item.path && d.id == item.id && d.eligible)
            .ok_or("Device disappeared or metadata changed")?;
        let index = self.index_for_path(&current.path)?.ok_or(
            "Gamepad not accessible to SDL; check read permission/session ACL and kernel driver",
        )?;
        let joystick = self.joysticks.open(index).map_err(|e| e.to_string())?;
        let controller = if self.controllers.is_game_controller(index) {
            Some(self.controllers.open(index).map_err(|e| e.to_string())?)
        } else {
            None
        };
        if !joystick.attached()
            || !inventory()?
                .iter()
                .any(|d| d.eligible && d.id == current.id && d.path == current.path)
        {
            return Err("Device identity changed while opening; no input baseline accepted".into());
        }
        let info = DeviceInfo {
            id: item.id.clone(),
            name: item.name.clone(),
            path: item.path.clone(),
            mapping: controller.as_ref().map_or_else(
                || "raw fallback; unknown physical layout".into(),
                |c| c.mapping(),
            ),
            reconnectable: item.reconnectable,
            synthetic: false,
        };
        let controls = match &controller {
            Some(c) => mapped_controls(c, &joystick),
            None => raw_controls(&joystick),
        };
        if controls.is_empty() {
            return Err("No supported input controls".into());
        }
        let mut opened = Opened {
            joystick,
            controller,
            controls,
            info,
            values: vec![],
        };
        // SDL initial events establish a baseline; they are not physical press edges.
        self.events.pump_events();
        for _ in self.events.poll_iter() {}
        opened.values = opened.snapshot()?;
        Ok(opened)
    }
}
#[derive(Clone, Debug)]
enum Control {
    Button(Button),
    Stick(Axis, Axis),
    Trigger(Axis),
    Axis(Axis),
    RawButton(u32),
    RawAxis(u32),
    Hat(u32, u8),
}
struct Opened {
    joystick: Joystick,
    controller: Option<GameController>,
    controls: Vec<(Control, Definition)>,
    info: DeviceInfo,
    values: Vec<InputValue>,
}
fn mapped_button(button: Button, sony: bool) -> Definition {
    let (suffix, name) = match button {
        Button::A => ("a/click", if sony { "South (Cross)" } else { "South (A)" }),
        Button::B => ("b/click", if sony { "East (Circle)" } else { "East (B)" }),
        Button::X => ("x/click", if sony { "West (Square)" } else { "West (X)" }),
        Button::Y => (
            "y/click",
            if sony {
                "North (Triangle)"
            } else {
                "North (Y)"
            },
        ),
        Button::Back => (
            "view/click",
            if sony {
                "View (Share/Create)"
            } else {
                "View / Back"
            },
        ),
        Button::Start => (
            "menu/click",
            if sony {
                "Menu (Options)"
            } else {
                "Menu / Start"
            },
        ),
        Button::LeftShoulder => (
            "shoulder_left/click",
            if sony {
                "Left shoulder (L1)"
            } else {
                "Left shoulder (LB)"
            },
        ),
        Button::RightShoulder => (
            "shoulder_right/click",
            if sony {
                "Right shoulder (R1)"
            } else {
                "Right shoulder (RB)"
            },
        ),
        Button::LeftStick => ("thumbstick_left/click", "Left stick click"),
        Button::RightStick => ("thumbstick_right/click", "Right stick click"),
        Button::DPadUp => ("dpad_up/click", "D-pad up"),
        Button::DPadDown => ("dpad_down/click", "D-pad down"),
        Button::DPadLeft => ("dpad_left/click", "D-pad left"),
        Button::DPadRight => ("dpad_right/click", "D-pad right"),
        _ => {
            return Definition::new(
                format!("/gamepad/input/{}/click", button.string()),
                format!("{} (SDL mapped)", button.string()),
                2,
                "Local extension; no standard OpenXR path claimed.",
            );
        }
    };
    Definition::new(
        format!("/user/gamepad/input/{suffix}"),
        name,
        2,
        "Common positional semantics using OpenXR Xbox gamepad component names; physical label retained where identified. Does not claim the physical device is an Xbox.",
    )
}
fn native_binding(binding: sdl2::sys::SDL_GameControllerButtonBind, j: &Joystick) -> bool {
    use sdl2::sys::SDL_GameControllerBindType::*;
    let within = |index: i32, count: u32| index >= 0 && (index as u32) < count;
    // SDL tags which union member is initialized. Only metadata is inspected.
    unsafe {
        match binding.bindType {
            SDL_CONTROLLER_BINDTYPE_BUTTON => within(binding.value.button, j.num_buttons()),
            SDL_CONTROLLER_BINDTYPE_AXIS => within(binding.value.axis, j.num_axes()),
            SDL_CONTROLLER_BINDTYPE_HAT => {
                within(binding.value.hat.hat, j.num_hats())
                    && (1..=15).contains(&binding.value.hat.hat_mask)
            }
            SDL_CONTROLLER_BINDTYPE_NONE => false,
        }
    }
}
fn mapped_controls(c: &GameController, j: &Joystick) -> Vec<(Control, Definition)> {
    let mut out = vec![];
    // Pointer lookup is borrowed from this live controller, used only on the SDL thread.
    let ptr = unsafe { sdl2::sys::SDL_GameControllerFromInstanceID(c.instance_id() as i32) };
    for b in [
        Button::A,
        Button::B,
        Button::X,
        Button::Y,
        Button::Back,
        Button::Start,
        Button::LeftShoulder,
        Button::RightShoulder,
        Button::LeftStick,
        Button::RightStick,
        Button::DPadUp,
        Button::DPadDown,
        Button::DPadLeft,
        Button::DPadRight,
        Button::Guide,
        Button::Misc1,
        Button::Paddle1,
        Button::Paddle2,
        Button::Paddle3,
        Button::Paddle4,
        Button::Touchpad,
    ] {
        if native_binding(
            unsafe { sdl2::sys::SDL_GameControllerGetBindForButton(ptr, b.to_ll()) },
            j,
        ) {
            out.push((
                Control::Button(b),
                mapped_button(b, c.vendor_id() == Some(0x054c)),
            ));
        }
    }
    let has = |a: Axis| {
        native_binding(
            unsafe { sdl2::sys::SDL_GameControllerGetBindForAxis(ptr, a.to_ll()) },
            j,
        )
    };
    for (side, x, y) in [
        ("left", Axis::LeftX, Axis::LeftY),
        ("right", Axis::RightX, Axis::RightY),
    ] {
        if has(x) && has(y) {
            out.push((Control::Stick(x,y),Definition::new(format!("/user/gamepad/input/thumbstick_{side}"),format!("{side} stick"),9,"OpenXR gamepad thumbstick vector, combining /x and /y components. Dimensionless [-1,1], +X right, +Y up.")));
        } else {
            for (a, component) in [(x, "x"), (y, "y")] {
                if has(a) {
                    out.push((
                        Control::Axis(a),
                        Definition::new(
                            format!("/user/gamepad/input/thumbstick_{side}/{component}"),
                            format!("{side} stick {component}"),
                            1,
                            "Single available stick axis, dimensionless [-1,1], +X right/+Y up.",
                        ),
                    ));
                }
            }
        }
    }
    for (side, a) in [("left", Axis::TriggerLeft), ("right", Axis::TriggerRight)] {
        if has(a) {
            out.push((
                Control::Trigger(a),
                Definition::new(
                    format!("/user/gamepad/input/trigger_{side}/value"),
                    format!("{side} trigger"),
                    8,
                    "Dimensionless [0,1], released to fully pressed; SDL mapped actuation.",
                ),
            ));
        }
    }
    out
}
fn raw_controls(j: &Joystick) -> Vec<(Control, Definition)> {
    let mut out = vec![];
    for i in 0..j.num_buttons().min(256) {
        out.push((
            Control::RawButton(i),
            Definition::new(
                format!("/gamepad/raw/button/{i}"),
                format!("Raw button {i}"),
                2,
                "Unknown layout: SDL joystick button index; no physical label assumed.",
            ),
        ));
    }
    for i in 0..j.num_axes().min(256) {
        out.push((Control::RawAxis(i),Definition::new(format!("/gamepad/raw/axis/{i}"),format!("Raw axis {i}"),1,"Unknown layout: SDL normalized dimensionless [-1,1] axis; native sign, no assumed center/direction/trigger semantics.")));
    }
    for i in 0..j.num_hats().min(64) {
        for (direction, bit) in [("up", 1), ("right", 2), ("down", 4), ("left", 8)] {
            out.push((Control::Hat(i,bit),Definition::new(format!("/gamepad/raw/hat/{i}/{direction}"),format!("Raw hat {i} {direction}"),2,"SDL hat direction bit, diagonals can activate two directions; no assumed physical D-pad identity.")));
        }
    }
    out
}
impl Opened {
    fn snapshot(&self) -> Result<Vec<InputValue>, String> {
        if !self.joystick.attached() {
            return Err("Selected controller disconnected".into());
        }
        self.controls
            .iter()
            .map(|(control, _)| {
                Ok(match *control {
                    Control::Button(b) => InputValue::Button(
                        self.controller
                            .as_ref()
                            .ok_or("Mapping disappeared")?
                            .button(b),
                    ),
                    Control::Stick(x, y) => {
                        let c = self.controller.as_ref().ok_or("Mapping disappeared")?;
                        InputValue::Stick([axis(c.axis(x)), -axis(c.axis(y))])
                    }
                    Control::Axis(a) => InputValue::Scalar(
                        axis(
                            self.controller
                                .as_ref()
                                .ok_or("Mapping disappeared")?
                                .axis(a),
                        ) * if matches!(a, Axis::LeftY | Axis::RightY) {
                            -1.
                        } else {
                            1.
                        },
                    ),
                    Control::Trigger(a) => InputValue::Scalar(trigger(
                        self.controller
                            .as_ref()
                            .ok_or("Mapping disappeared")?
                            .axis(a),
                    )),
                    Control::RawButton(b) => {
                        InputValue::Button(self.joystick.button(b).map_err(|e| e.to_string())?)
                    }
                    Control::RawAxis(a) => {
                        InputValue::Scalar(axis(self.joystick.axis(a).map_err(|e| e.to_string())?))
                    }
                    Control::Hat(h, bit) => InputValue::Button(
                        self.joystick.hat(h).map_err(|e| e.to_string())? as u8 & bit != 0,
                    ),
                })
            })
            .collect()
    }
    fn event(&mut self, e: Event) -> Vec<(usize, InputValue)> {
        let id = self.joystick.instance_id();
        let mut out = vec![];
        for (i, (c, _)) in self.controls.iter().enumerate() {
            let v = match (&e, c) {
                (Event::ControllerButtonDown { which, button, .. }, Control::Button(b))
                    if *which == id && button == b =>
                {
                    Some(InputValue::Button(true))
                }
                (Event::ControllerButtonUp { which, button, .. }, Control::Button(b))
                    if *which == id && button == b =>
                {
                    Some(InputValue::Button(false))
                }
                (
                    Event::ControllerAxisMotion {
                        which,
                        axis: a,
                        value,
                        ..
                    },
                    Control::Trigger(b),
                ) if *which == id && a == b => Some(InputValue::Scalar(trigger(*value))),
                (
                    Event::ControllerAxisMotion {
                        which,
                        axis: a,
                        value,
                        ..
                    },
                    Control::Axis(b),
                ) if *which == id && a == b => Some(InputValue::Scalar(
                    axis(*value)
                        * if matches!(a, Axis::LeftY | Axis::RightY) {
                            -1.
                        } else {
                            1.
                        },
                )),
                (
                    Event::ControllerAxisMotion {
                        which,
                        axis: a,
                        value,
                        ..
                    },
                    Control::Stick(x, y),
                ) if *which == id && (a == x || a == y) => {
                    let InputValue::Stick(mut pair) = self.values[i] else {
                        continue;
                    };
                    if a == x {
                        pair[0] = axis(*value);
                    } else {
                        pair[1] = -axis(*value);
                    }
                    Some(InputValue::Stick(pair))
                }
                (
                    Event::JoyButtonDown {
                        which, button_idx, ..
                    },
                    Control::RawButton(b),
                ) if *which == id && u32::from(*button_idx) == *b => Some(InputValue::Button(true)),
                (
                    Event::JoyButtonUp {
                        which, button_idx, ..
                    },
                    Control::RawButton(b),
                ) if *which == id && u32::from(*button_idx) == *b => {
                    Some(InputValue::Button(false))
                }
                (
                    Event::JoyAxisMotion {
                        which,
                        axis_idx,
                        value,
                        ..
                    },
                    Control::RawAxis(a),
                ) if *which == id && u32::from(*axis_idx) == *a => {
                    Some(InputValue::Scalar(axis(*value)))
                }
                (
                    Event::JoyHatMotion {
                        which,
                        hat_idx,
                        state,
                        ..
                    },
                    Control::Hat(h, bit),
                ) if *which == id && u32::from(*hat_idx) == *h => {
                    Some(InputValue::Button(*state as u8 & bit != 0))
                }
                _ => None,
            };
            if let Some(v) = v {
                self.values[i] = v.clone();
                out.push((i, v));
            }
        }
        out
    }
}

#[derive(Default, Debug)]
pub struct Selection {
    pub requested: Option<String>,
    pub locked: Option<String>,
    pub needs_restart: bool,
}
impl Selection {
    pub fn choose<'a>(
        &self,
        items: &'a [InventoryItem],
    ) -> Result<Option<&'a InventoryItem>, String> {
        if self.needs_restart {
            return Err("Selected input had no reconnect-eligible MAC-shaped uniq; restart and run --list for the current --device ID after reconnect. A USB/receiver serial does not identify the physical pad".into());
        }
        let wanted = self.locked.as_ref().or(self.requested.as_ref());
        let matches: Vec<_> = items
            .iter()
            .filter(|i| i.eligible && wanted.is_none_or(|id| id == &i.id))
            .collect();
        match matches.len() {0=>Ok(None),1=>Ok(matches.first().copied()),_=>Err("Multiple matching gamepads; select one exact --device ID from --list. Duplicate kernel uniq values are ambiguous.".into())}
    }
    fn selected(&mut self, info: &DeviceInfo) {
        self.locked = Some(info.id.clone());
    }
    pub fn disconnected(&mut self, info: &DeviceInfo) {
        self.needs_restart = !info.reconnectable;
    }
}
fn selected_status(hub: &Hub) -> String {
    let mut status = format!("Selected {} ({})", hub.device.name, hub.device.id);
    if let Some(reason) = hub.virtual_unavailable() {
        status.push_str("; ");
        status.push_str(reason);
    }
    status
}
pub fn run_sdl(
    source: Arc<Source>,
    stop: Arc<AtomicBool>,
    device: Option<String>,
    mapping: Option<PathBuf>,
    virtual_config: Option<crate::virtual_pose::Config>,
) -> Result<(), String> {
    let mut sdl = Sdl::new(mapping.as_deref())?;
    let mut selection = Selection {
        requested: device,
        ..Default::default()
    };
    let mut open: Option<(Opened, Arc<Hub>)> = None;
    let mut next_scan = Instant::now();
    let mut next_observation = 0;
    let mut transitions = Vec::new();
    let mut message = String::new();
    while !stop.load(Ordering::Relaxed) {
        sdl.events.pump_events();
        let events: Vec<_> = sdl.events.poll_iter().take(8192).collect();
        if let Some((pad, hub)) = open.as_mut() {
            let id = pad.joystick.instance_id();
            if events.len() >= 8192 {
                hub.disconnect(source.clock.now());
                return Err("Gamepad event backlog exceeded 8192; input invalidated, restart to re-establish the baseline".into());
            }
            let remapped = events
                .iter()
                .any(|e| matches!(e,Event::ControllerDeviceRemapped{which,..} if *which==id));
            let disconnected=!pad.joystick.attached()||events.iter().any(|e|matches!(e,Event::JoyDeviceRemoved{which,..}|Event::ControllerDeviceRemoved{which,..} if *which==id));
            if remapped || disconnected {
                hub.disconnect(source.clock.now());
                if remapped {
                    hub.retire();
                } else {
                    selection.disconnected(&pad.info);
                }
                log::info!(
                    "Selected device {}",
                    if remapped {
                        "mapping changed; renegotiation required"
                    } else {
                        "disconnected"
                    }
                );
                open = None;
                next_scan = Instant::now();
            } else {
                transitions.extend(events.into_iter().flat_map(|e| pad.event(e)));
                if source.clock.now() >= next_observation {
                    match pad.snapshot() {
                        Ok(values) => {
                            hub.batch(&transitions, &values, source.clock.now())?;
                            pad.values = values;
                            transitions.clear();
                            next_observation = hub.next_observation();
                        }
                        Err(e) => {
                            hub.disconnect(source.clock.now());
                            selection.disconnected(&pad.info);
                            log::warn!("Input error: {e}");
                            open = None;
                            next_scan = Instant::now();
                        }
                    }
                }
            }
        }
        if Instant::now() >= next_scan {
            next_scan = Instant::now() + Duration::from_secs(1);
            let items = sdl.list()?;
            let mut status = if open.is_some() {
                "Gamepad input device open".to_string()
            } else {
                "No accessible gamepad selected; attach one and use --list".to_string()
            };
            if open.is_none() {
                match selection.choose(&items) {
                    Ok(Some(item)) => match sdl.open(item) {
                        Ok(pad) => {
                            let hub = Hub::with_virtual(
                                pad.info.clone(),
                                pad.controls.iter().map(|(_, d)| d.clone()).collect(),
                                pad.values.clone(),
                                source.clock.clone(),
                                source.clock.now(),
                                virtual_config,
                            )?;
                            transitions.clear();
                            next_observation = hub.next_observation();
                            selection.selected(&pad.info);
                            source.install(hub.clone());
                            status = selected_status(&hub);
                            open = Some((pad, hub));
                        }
                        Err(e) => status = e,
                    },
                    Ok(None) => {
                        if let Some(id) = selection.locked.as_ref().or(selection.requested.as_ref())
                        {
                            status = format!(
                                "Waiting for gamepad {id}. Run --list to check the current device IDs"
                            );
                        }
                    }
                    Err(e) => status = e,
                }
            }
            source.report(serde_json::json!({"name":"SDL2 Linux evdev","status":status,"inventory":items,"selection":selection.locked.as_ref().or(selection.requested.as_ref()),"mac_shaped_uniq_required_for_reconnect":true}));
            if status != message {
                eprintln!("{status}");
                message = status;
            }
        }
        // Drain native edges and detect removal between phase-aligned snapshots.
        let wait = if open.is_some() {
            next_observation
                .saturating_sub(source.clock.now())
                .min(OBSERVATION_PERIOD_NS)
        } else {
            OBSERVATION_PERIOD_NS
        };
        std::thread::sleep(Duration::from_nanos(wait));
    }
    if let Some((_, hub)) = open {
        hub.disconnect(source.clock.now());
    }
    Ok(())
}

pub fn synthetic_device() -> DeviceInfo {
    DeviceInfo {
        id: "synthetic:gamepad".into(),
        name: "SYNTHETIC gamepad (not hardware)".into(),
        path: "simulation".into(),
        mapping: "deterministic positional test mapping".into(),
        reconnectable: true,
        synthetic: true,
    }
}
pub fn synthetic_definitions() -> Vec<Definition> {
    let mut defs = [
        Button::A,
        Button::B,
        Button::X,
        Button::Y,
        Button::Back,
        Button::Start,
        Button::LeftShoulder,
        Button::RightShoulder,
        Button::LeftStick,
        Button::RightStick,
        Button::DPadUp,
        Button::DPadDown,
        Button::DPadLeft,
        Button::DPadRight,
    ]
    .into_iter()
    .map(|b| mapped_button(b, false))
    .collect::<Vec<_>>();
    for side in ["left", "right"] {
        defs.push(Definition::new(
            format!("/user/gamepad/input/thumbstick_{side}"),
            format!("{side} stick (SYNTHETIC)"),
            9,
            "Synthetic dimensionless [-1,1] pair, +X right/+Y up.",
        ));
    }
    for side in ["left", "right"] {
        defs.push(Definition::new(
            format!("/user/gamepad/input/trigger_{side}/value"),
            format!("{side} trigger (SYNTHETIC)"),
            8,
            "Synthetic actuation [0,1].",
        ));
    }
    defs
}
pub fn synthetic_values(tick: u64) -> Vec<InputValue> {
    let phase = (tick / 100) % 4;
    let mut v = vec![InputValue::Button(false); 14];
    v[0] = InputValue::Button(phase == 1);
    v[10] = InputValue::Button(phase == 2);
    v.extend([
        InputValue::Stick([0.5, -0.25]),
        InputValue::Stick([-0.125, 0.75]),
        InputValue::Scalar(0.25),
        InputValue::Scalar(0.75),
    ]);
    v
}
/// Explicit opt-in scripted software controls; the ordinary synthetic sequence is unchanged.
/// 10-second cycle at nominal 100 Hz, all motion/command edges visible on raw inputs.
pub fn synthetic_virtual_values(tick: u64) -> Vec<InputValue> {
    let t = tick % 1000;
    let mut values = vec![InputValue::Button(false); 14];
    values.extend([
        InputValue::Stick([0.; 2]),
        InputValue::Stick([0.; 2]),
        InputValue::Scalar(0.),
        InputValue::Scalar(0.),
    ]);
    match t {
        50..=54 | 700..=704 | 800..=804 => values[5] = InputValue::Button(true),
        60..=109 => values[14] = InputValue::Stick([0., 1.]),
        110..=159 => values[14] = InputValue::Stick([1., 0.]),
        160..=209 => values[17] = InputValue::Scalar(1.),
        210..=259 => values[16] = InputValue::Scalar(1.),
        260..=309 => values[15] = InputValue::Stick([1., 0.]),
        310..=359 => values[15] = InputValue::Stick([0., 1.]),
        360..=409 => values[7] = InputValue::Button(true),
        410..=459 => values[6] = InputValue::Button(true),
        460..=509 => values[15] = InputValue::Stick([-1., 0.]),
        510..=559 => values[15] = InputValue::Stick([0., -1.]),
        560..=609 => values[14] = InputValue::Stick([0., -1.]),
        610..=659 => values[14] = InputValue::Stick([-1., 0.]),
        705..=749 | 805..=849 => {
            values[14] = InputValue::Stick([0.6, 0.8]);
            values[15] = InputValue::Stick([0.6, 0.8]);
            values[17] = InputValue::Scalar(1.);
            values[7] = InputValue::Button(true);
        }
        750..=754 | 850..=854 => values[4] = InputValue::Button(true),
        _ => {}
    }
    values
}
pub fn run_synthetic(
    source: Arc<Source>,
    stop: Arc<AtomicBool>,
    lifecycle: bool,
    virtual_config: Option<crate::virtual_pose::Config>,
    virtual_demo: bool,
) -> Result<(), String> {
    let started = source.clock.now();
    let mut hub: Option<Arc<Hub>> = None;
    let mut previous = vec![];
    source.report(serde_json::json!({"name":"SYNTHETIC","status":"Deterministic software events, no physical input opened","lifecycle":lifecycle,"virtual_demo":virtual_demo}));
    while !stop.load(Ordering::Relaxed) {
        let tick = (source.clock.now() - started) / OBSERVATION_PERIOD_NS;
        let disconnected = lifecycle && (tick % 1200 >= 600 && tick % 1200 < 800);
        if disconnected {
            if let Some(h) = hub.take() {
                h.disconnect(source.clock.now());
            }
        } else {
            let values = if virtual_demo {
                synthetic_virtual_values(tick)
            } else {
                synthetic_values(tick)
            };
            if hub.is_none() {
                let h = Hub::with_virtual(
                    synthetic_device(),
                    synthetic_definitions(),
                    values.clone(),
                    source.clock.clone(),
                    source.clock.now(),
                    virtual_config,
                )?;
                source.install(h.clone());
                hub = Some(h);
                previous = values.clone();
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let events = values
                .iter()
                .enumerate()
                .filter(|(i, v)| previous[*i] != **v)
                .map(|(i, v)| (i, v.clone()))
                .collect::<Vec<_>>();
            hub.as_ref()
                .unwrap()
                .batch(&events, &values, source.clock.now())?;
            previous = values;
        }
        let wait = hub.as_ref().map_or(OBSERVATION_PERIOD_NS, |h| {
            h.next_observation().saturating_sub(source.clock.now())
        });
        std::thread::sleep(Duration::from_nanos(wait));
    }
    if let Some(h) = hub {
        h.disconnect(source.clock.now());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bitmap(bits: &[usize]) -> String {
        let mut words = [0u64; 12];
        for &b in bits {
            words[b / 64] |= 1u64 << (b % 64);
        }
        words
            .iter()
            .rev()
            .map(|v| format!("{v:x}"))
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn item(id: &str, has_uniq: bool) -> InventoryItem {
        InventoryItem {
            id: id.into(),
            name: "test".into(),
            path: "/dev/input/event99".into(),
            uniq: has_uniq.then(|| "aa:bb:cc:dd:ee:ff".into()),
            usb_serial: None,
            input_slot: "/sys/devices/test/input/input99".into(),
            reconnectable: has_uniq,
            vendor: "0001".into(),
            product: "0002".into(),
            eligible: true,
            diagnostic: "test".into(),
        }
    }
    #[test]
    fn never_accept_keyboard_mouse_or_keychron_false_joystick() {
        assert!(gamepad_keys(&bitmap(&[0x130]), &bitmap(&[0, 1]), "0"));
        assert!(gamepad_keys(&bitmap(&[0x130]), "0", "0")); // Digital-only pad.
        assert!(gamepad_keys(&bitmap(&[0x100]), &bitmap(&[0x10, 0x11]), "0")); // Raw hat/button pad.
        assert!(gamepad_keys(&bitmap(&[0x120]), &bitmap(&[0, 1]), "0"));
        // Wacom pad-like nodes can expose BTN_MISC/gamepad buttons and XY.
        // A digitizer marker must still prevent event reads on those nodes.
        for digitizer in 0x140..=0x14f {
            assert!(!gamepad_keys(
                &bitmap(&[0x100, 0x120, digitizer]),
                &bitmap(&[0, 1]),
                "0"
            ));
        }
        for key in [1, 30, 0x110, 0x14a] {
            assert!(!gamepad_keys(&bitmap(&[key, 0x130]), &bitmap(&[0, 1]), "0"));
        }
        assert!(!gamepad_keys(
            "c000 0 0 40000001000000 1200000000 0 100000800000000 40000010cc00 10168000000000 0",
            "10000030000",
            "0"
        ));
        assert!(!gamepad_keys(&bitmap(&[0x130]), &bitmap(&[0, 1]), "3"));
    }
    #[test]
    fn xbox_series_share_and_gamepad_auxiliary_keys_are_not_keyboards() {
        // xpad Series: face/shoulder/menu/view/mode/stick buttons + KEY_RECORD.
        let series = "7cdb000000000000 0 8000000000 0 0";
        assert!(gamepad_keys(series, "3003f", "0"));
        for auxiliary in [139, 158, 167, 172] {
            assert!(gamepad_keys(
                &bitmap(&[0x130, auxiliary]),
                &bitmap(&[0, 1]),
                "0"
            ));
            assert!(!gamepad_keys(
                &bitmap(&[0x130, auxiliary, 30]),
                &bitmap(&[0, 1]),
                "0"
            ));
            assert!(!gamepad_keys(&bitmap(&[0x130, auxiliary]), "0", "0"));
            assert!(!gamepad_keys(&bitmap(&[auxiliary]), &bitmap(&[0, 1]), "0"));
        }
    }
    #[test]
    fn playstation_gamepad_and_edge_buttons_pass_but_touchpad_and_sensors_do_not() {
        // Linux hid-playstation.c ps_gamepad_buttons / ps_gamepad_create:
        // PS4 Share / PS5 Create = BTN_SELECT; PS Home = BTN_MODE.
        // Touchpad click lives on a separate mouse/touch device, never opened here.
        // https://github.com/torvalds/linux/blob/master/drivers/hid/hid-playstation.c
        let buttons = [
            304, 305, 307, 308, 310, 311, 312, 313, 314, 315, 316, 317, 318,
        ];
        let axes = bitmap(&[0, 1, 2, 3, 4, 5, 16, 17]);
        assert!(gamepad_keys(&bitmap(&buttons), &axes, "0"));
        let edge = buttons
            .into_iter()
            .chain([0x2c0, 0x2c1, 0x2c2, 0x2c3])
            .collect::<Vec<_>>();
        assert!(gamepad_keys(&bitmap(&edge), &axes, "0"));
        assert!(!gamepad_keys(
            &bitmap(&[0x110, 0x14a, 0x145]),
            &bitmap(&[0, 1, 0x35, 0x36]),
            "0"
        ));
        assert!(!gamepad_keys("0", &bitmap(&[0, 1, 2, 3, 4, 5]), "0"));
        // Composite keyboard+pad remains excluded even with an auxiliary key.
        assert!(!gamepad_keys(&bitmap(&[304, 30, 139]), &axes, "0"));
    }
    #[test]
    fn normalization_includes_endpoints_preserves_center_and_up() {
        assert_eq!(axis(i16::MIN), -1.);
        assert_eq!(axis(i16::MAX), 1.);
        assert_eq!(axis(0), 0.);
        assert_eq!(-axis(i16::MIN), 1.);
        assert_eq!(trigger(0), 0.);
        assert_eq!(trigger(i16::MAX), 1.);
        for v in i16::MIN..=i16::MAX {
            assert!((-1.0..=1.).contains(&axis(v)));
            assert!((0.0..=1.).contains(&trigger(v)));
        }
    }
    #[test]
    fn positional_names_preserve_playstation_labels_and_custom_paths() {
        for b in [Button::A, Button::B, Button::X, Button::Y] {
            assert_eq!(mapped_button(b, true).id, mapped_button(b, false).id);
        }
        assert!(mapped_button(Button::A, true).name.contains("Cross"));
        assert!(mapped_button(Button::A, false).name.contains("A"));
        assert!(
            mapped_button(Button::Guide, false)
                .id
                .starts_with("/gamepad/")
        );
    }
    fn receiver(slot: &str, uniq: Option<&str>) -> InventoryItem {
        let phys = "usb-0000:00:14.0-1/input0"; // xpad uses this for every receiver interface.
        let usb_serial = "E0B411E0";
        let mut device = item("", false);
        (device.id, device.reconnectable) =
            identity("045e", "02a1", uniq, Some(usb_serial), phys, slot);
        device.uniq = uniq.map(str::to_string);
        device.usb_serial = Some(usb_serial.into());
        device.input_slot = slot.into();
        device
    }
    #[test]
    fn shared_receiver_serial_and_phys_leave_each_input_slot_selectable() {
        let a = receiver("/sys/devices/usb1/1-1/1-1:1.0/input/input20", None);
        let b = receiver("/sys/devices/usb1/1-1/1-1:1.2/input/input21", None);
        assert_eq!(a.usb_serial, b.usb_serial);
        assert_ne!(a.id, b.id);
        assert!(!a.reconnectable && !b.reconnectable);
        let devices = [a, b];
        assert!(Selection::default().choose(&devices).is_err());
        for device in &devices {
            let selection = Selection {
                requested: Some(device.id.clone()),
                ..Default::default()
            };
            assert_eq!(selection.choose(&devices).unwrap().unwrap().id, device.id);
        }
    }
    #[test]
    fn receiver_replacement_after_unplug_cannot_take_over_even_the_same_slot() {
        let a = receiver("/sys/devices/usb1/1-1/1-1:1.0/input/input20", None);
        let info = DeviceInfo {
            id: a.id.clone(),
            name: "Pad A".into(),
            path: a.path.clone(),
            mapping: "test".into(),
            reconnectable: a.reconnectable,
            synthetic: false,
        };
        let mut selection = Selection {
            requested: Some(a.id.clone()),
            ..Default::default()
        };
        selection.selected(&info);
        selection.disconnected(&info);
        let mut replacement = a.clone();
        replacement.name = "Different pad B".into();
        assert!(selection.choose(&[replacement]).is_err());
        let replacement = receiver("/sys/devices/usb1/1-1/1-1:1.0/input/input90", None);
        assert!(
            selection
                .choose(std::slice::from_ref(&replacement))
                .is_err()
        );
        // Only an explicit fresh process/selection can establish the new baseline.
        assert!(
            Selection {
                requested: Some(replacement.id.clone()),
                ..Default::default()
            }
            .choose(&[replacement])
            .unwrap()
            .is_some()
        );
    }
    #[test]
    fn only_mac_shaped_uniq_enables_reconnect_and_claimed_uniq_collisions_still_reject() {
        let a = receiver("/sys/devices/input/input20", Some("aa:bb:cc:dd:ee:ff"));
        let b = receiver("/sys/devices/input/input90", Some("AA:BB:CC:DD:EE:FF"));
        assert!(a.reconnectable && b.reconnectable);
        assert_eq!(a.id, b.id);
        let selection = Selection {
            requested: Some(a.id.clone()),
            ..Default::default()
        };
        assert!(
            selection
                .choose(std::slice::from_ref(&b))
                .unwrap()
                .is_some()
        );
        assert!(selection.choose(&[a, b]).is_err());
        assert!(
            !identity(
                "045e",
                "0719",
                Some(""),
                Some("fixed-clone-serial"),
                "phys",
                "slot"
            )
            .1
        );
    }
    #[test]
    fn usb_serial_in_uniq_and_invalid_addresses_require_explicit_restart() {
        for uniq in [
            "E0B411E0",
            "fixed-clone-serial",
            "",
            "00:00:00:00:00:00",
            "aa:bb:cc:dd:ee",
            "aa:bb:cc:dd:ee:ff:00",
            "a:bb:cc:dd:ee:ff",
            "aa-bb-cc-dd-ee-ff",
            "aa:bb:cc:dd:ee:gg",
        ] {
            let a = receiver("/sys/devices/input/input20", Some(uniq));
            let b = receiver("/sys/devices/input/input90", Some(uniq));
            assert!(!a.reconnectable && !b.reconnectable, "{uniq}");
            assert_ne!(a.id, b.id);
            let mut selection = Selection {
                requested: Some(a.id.clone()),
                ..Default::default()
            };
            let info = DeviceInfo {
                id: a.id.clone(),
                name: a.name.clone(),
                path: a.path.clone(),
                mapping: "test".into(),
                reconnectable: a.reconnectable,
                synthetic: false,
            };
            assert!(selection.choose(&[a.clone(), b.clone()]).unwrap().is_some());
            selection.selected(&info);
            selection.disconnected(&info);
            // Even replacement on the very same slot cannot take over.
            assert!(selection.choose(&[a]).is_err());
            assert!(selection.choose(&[b]).is_err());
        }
        assert!(mac_shaped_uniq("00:00:00:00:00:01"));
        assert!(mac_shaped_uniq("AA:BB:CC:DD:EE:FF"));
    }
    #[test]
    fn selection_status_explains_unsupported_virtual_controls() {
        let hub = Hub::with_virtual(
            synthetic_device(),
            vec![Definition::new("/gamepad/raw/axis/0", "raw", 1, "unknown")],
            vec![InputValue::Scalar(0.)],
            Arc::new(crate::input::Clock::default()),
            0,
            Some(crate::virtual_pose::Config::default()),
        )
        .unwrap();
        let message = selected_status(&hub);
        assert!(message.starts_with("Selected SYNTHETIC"));
        assert!(message.contains(
            "Virtual pose unavailable: missing mapped /user/gamepad/input/thumbstick_left"
        ));
        assert!(message.contains("raw inputs remain available"));
    }
    #[test]
    fn identity_selection_never_switches_or_guesses_duplicate_serials() {
        let mut selection = Selection::default();
        let a = item("a", true);
        let b = item("b", true);
        assert!(selection.choose(&[a.clone(), b.clone()]).is_err());
        selection.requested = Some("a".into());
        assert_eq!(
            selection
                .choose(&[a.clone(), b.clone()])
                .unwrap()
                .unwrap()
                .id,
            "a"
        );
        selection.locked = Some("a".into());
        assert!(
            selection
                .choose(std::slice::from_ref(&b))
                .unwrap()
                .is_none()
        );
        assert!(selection.choose(&[a.clone(), a]).is_err());
        let mut info = synthetic_device();
        info.reconnectable = false;
        selection.disconnected(&info);
        assert!(selection.choose(&[b]).is_err());
    }
}

#[cfg(test)]
mod sdl_tests {
    use super::*;
    struct VirtualDevice(i32);
    impl Drop for VirtualDevice {
        fn drop(&mut self) {
            // This index is owned by the virtual test, never physical hardware.
            unsafe {
                sdl2::sys::SDL_JoystickDetachVirtual(self.0);
            }
        }
    }
    #[test]
    fn sdl_virtual_devices_exercise_mapped_native_events_and_raw_fallback() {
        let mut sdl = Sdl::new(None).unwrap();
        // SDL's in-process virtual driver writes software state only.
        let device = VirtualDevice(unsafe {
            sdl2::sys::SDL_JoystickAttachVirtual(
                sdl2::sys::SDL_JoystickType::SDL_JOYSTICK_TYPE_GAMECONTROLLER,
                6,
                15,
                0,
            )
        });
        assert!(device.0 >= 0);
        assert!(sdl.controllers.is_game_controller(device.0 as u32));
        let joystick = sdl.joysticks.open(device.0 as u32).unwrap();
        let controller = sdl.controllers.open(device.0 as u32).unwrap();
        let controls = mapped_controls(&controller, &joystick);
        assert_eq!(controls.len(), 19);
        let mut pad = Opened {
            joystick,
            controller: Some(controller),
            controls,
            info: synthetic_device(),
            values: vec![],
        };
        sdl.events.pump_events();
        for _ in sdl.events.poll_iter() {}
        pad.values = pad.snapshot().unwrap();
        let hub = Hub::with_virtual(
            pad.info.clone(),
            pad.controls.iter().map(|(_, d)| d.clone()).collect(),
            pad.values.clone(),
            Arc::new(crate::input::Clock::default()),
            1,
            Some(crate::virtual_pose::Config::default()),
        )
        .unwrap();
        // Borrow pointer from the still-live virtual joystick, never an arbitrary ID.
        let ptr =
            unsafe { sdl2::sys::SDL_JoystickFromInstanceID(pad.joystick.instance_id() as i32) };
        assert!(!ptr.is_null());
        let a = pad
            .controls
            .iter()
            .position(|(_, d)| d.id.ends_with("/a/click"))
            .unwrap();
        let left = pad
            .controls
            .iter()
            .position(|(_, d)| d.id == "/user/gamepad/input/thumbstick_left")
            .unwrap();
        let trig = pad
            .controls
            .iter()
            .position(|(_, d)| d.id.ends_with("/trigger_left/value"))
            .unwrap();
        let mut events = vec![];
        for pressed in [1, 0] {
            assert_eq!(
                unsafe { sdl2::sys::SDL_JoystickSetVirtualButton(ptr, 0, pressed) },
                0
            );
            sdl.events.pump_events();
            events.extend(sdl.events.poll_iter().flat_map(|e| pad.event(e)));
        }
        assert_eq!(
            events
                .iter()
                .filter(|(i, _)| *i == a)
                .map(|(_, v)| v.clone())
                .collect::<Vec<_>>(),
            [InputValue::Button(true), InputValue::Button(false)]
        );
        assert_eq!(
            unsafe { sdl2::sys::SDL_JoystickSetVirtualAxis(ptr, 0, i16::MAX) },
            0
        );
        assert_eq!(
            unsafe { sdl2::sys::SDL_JoystickSetVirtualAxis(ptr, 1, i16::MIN) },
            0
        );
        assert_eq!(
            unsafe { sdl2::sys::SDL_JoystickSetVirtualAxis(ptr, 4, i16::MAX) },
            0
        );
        sdl.events.pump_events();
        events.extend(sdl.events.poll_iter().flat_map(|e| pad.event(e)));
        let values = pad.snapshot().unwrap();
        assert_eq!(values[left], InputValue::Stick([1., 1.]));
        assert_eq!(values[trig], InputValue::Scalar(1.));
        hub.batch(&events, &values, 2).unwrap();
        // Drive the entire mapped virtual-control script through real SDL events,
        // then the same hub/publication encoder used by HTTP/WebRTC.
        let controller_ptr = unsafe {
            sdl2::sys::SDL_GameControllerFromInstanceID(
                pad.controller.as_ref().unwrap().instance_id() as i32,
            )
        };
        let definitions = synthetic_definitions();
        for tick in 0..1000 {
            let desired = synthetic_virtual_values(tick);
            let set_axis = |axis: Axis, value: f64| {
                let binding = unsafe {
                    sdl2::sys::SDL_GameControllerGetBindForAxis(controller_ptr, axis.to_ll())
                };
                let native = unsafe { binding.value.axis };
                let value = (value * if value < 0. { 32768. } else { 32767. }).round() as i16;
                assert_eq!(
                    unsafe { sdl2::sys::SDL_JoystickSetVirtualAxis(ptr, native, value) },
                    0
                );
            };
            for (control, definition) in &pad.controls {
                let desired = definitions
                    .iter()
                    .position(|d| d.id == definition.id)
                    .map(|i| &desired[i]);
                match control {
                    Control::Button(button) => {
                        let binding = unsafe {
                            sdl2::sys::SDL_GameControllerGetBindForButton(
                                controller_ptr,
                                button.to_ll(),
                            )
                        };
                        let pressed = matches!(desired, Some(InputValue::Button(true)));
                        assert_eq!(
                            unsafe {
                                sdl2::sys::SDL_JoystickSetVirtualButton(
                                    ptr,
                                    binding.value.button,
                                    u8::from(pressed),
                                )
                            },
                            0
                        );
                    }
                    Control::Stick(x, y) => {
                        let Some(InputValue::Stick(v)) = desired else {
                            panic!("Missing scripted stick")
                        };
                        set_axis(*x, v[0]);
                        set_axis(*y, -v[1]);
                    }
                    Control::Trigger(axis) => {
                        let Some(InputValue::Scalar(v)) = desired else {
                            panic!("Missing scripted trigger")
                        };
                        set_axis(*axis, 2. * v - 1.);
                    }
                    _ => {}
                }
            }
            sdl.events.pump_events();
            let events = sdl
                .events
                .poll_iter()
                .flat_map(|e| pad.event(e))
                .collect::<Vec<_>>();
            let values = pad.snapshot().unwrap();
            hub.batch(&events, &values, (tick + 1) * 10_000_000)
                .unwrap();
            if tick == 60 {
                assert_eq!(hub.status()["virtual_pose"]["enabled"], true);
            }
        }
        assert_eq!(hub.status()["virtual_pose"]["enabled"], false);
        assert_eq!(hub.status()["virtual_pose"]["valid"], true);
        let request = crate::protocol::Request {
            id: 1,
            group: 0,
            channel: 1,
            interval: 10_000_000,
            phase: 0,
            prediction_offset: 0,
            sequence_number_format: None,
            bundles: vec![
                hub.capabilities
                    .descriptors
                    .iter()
                    .enumerate()
                    .map(|(i, d)| crate::protocol::SampleBinding {
                        descriptor: i as u32,
                        format: d.formats[0],
                        space: d.spaces.first().copied().unwrap_or(0),
                    })
                    .collect(),
            ],
        };
        hub.capabilities.validate_request(&request).unwrap();
        hub.check(&request).unwrap();
        let publication = Arc::new(std::sync::Mutex::new(
            crate::protocol::PublicationState::new(&request, 0),
        ));
        hub.observe(&request, &publication).unwrap();
        assert!(publication.lock().unwrap().candidate().is_some());
        // Reject binding metadata outside this real SDL virtual device's counts.
        use sdl2::sys::{
            SDL_GameControllerBindType::*, SDL_GameControllerButtonBind as Bind,
            SDL_GameControllerButtonBind__bindgen_ty_1 as BindingValue,
        };
        assert!(!native_binding(
            Bind {
                bindType: SDL_CONTROLLER_BINDTYPE_BUTTON,
                value: BindingValue { button: 99 }
            },
            &pad.joystick
        ));
        assert!(!native_binding(
            Bind {
                bindType: SDL_CONTROLLER_BINDTYPE_AXIS,
                value: BindingValue { axis: 99 }
            },
            &pad.joystick
        ));
        assert!(native_binding(
            Bind {
                bindType: SDL_CONTROLLER_BINDTYPE_AXIS,
                value: BindingValue { axis: 0 }
            },
            &pad.joystick
        ));
        drop(pad);
        drop(device);
        let raw = VirtualDevice(unsafe {
            sdl2::sys::SDL_JoystickAttachVirtual(
                sdl2::sys::SDL_JoystickType::SDL_JOYSTICK_TYPE_UNKNOWN,
                2,
                3,
                1,
            )
        });
        assert!(raw.0 >= 0);
        let joystick = sdl.joysticks.open(raw.0 as u32).unwrap();
        let controls = raw_controls(&joystick);
        assert_eq!(controls.len(), 9);
        assert!(
            controls
                .iter()
                .all(|(_, d)| d.id.starts_with("/gamepad/raw/"))
        );
        let mut pad = Opened {
            joystick,
            controller: None,
            controls,
            info: synthetic_device(),
            values: vec![],
        };
        sdl.events.pump_events();
        for _ in sdl.events.poll_iter() {}
        pad.values = pad.snapshot().unwrap();
        let ptr =
            unsafe { sdl2::sys::SDL_JoystickFromInstanceID(pad.joystick.instance_id() as i32) };
        assert_eq!(
            unsafe { sdl2::sys::SDL_JoystickSetVirtualButton(ptr, 2, 1) },
            0
        );
        assert_eq!(
            unsafe { sdl2::sys::SDL_JoystickSetVirtualAxis(ptr, 1, i16::MIN) },
            0
        );
        assert_eq!(
            unsafe { sdl2::sys::SDL_JoystickSetVirtualHat(ptr, 0, 3) },
            0
        );
        sdl.events.pump_events();
        let events = sdl
            .events
            .poll_iter()
            .flat_map(|e| pad.event(e))
            .collect::<Vec<_>>();
        assert!(events.contains(&(2, InputValue::Button(true))));
        let values = pad.snapshot().unwrap();
        assert_eq!(values[4], InputValue::Scalar(-1.));
        assert_eq!(values[5], InputValue::Button(true));
        assert_eq!(values[6], InputValue::Button(true));
        drop(raw);
        assert!(!pad.joystick.attached());
        assert!(pad.snapshot().is_err());
    }
}
