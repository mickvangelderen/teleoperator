//! Framework Views, inflated and updated on the Activity's main looper.
use super::{activity::ActivityId, camera::Tracking, sensors::Sensors};
use crate::phone::{self, Action, Hub, Motion};
use crate::tracking::{Output, Selection, TrackingMode};
use jni::{
    JNIEnv,
    errors::Result,
    objects::{GlobalRef, JObject, JString},
};
use jni_min_helper::{JObjectNew, JniProxy};
use ndk_sys::{
    AMOTION_EVENT_ACTION_CANCEL, AMOTION_EVENT_ACTION_DOWN, AMOTION_EVENT_ACTION_MOVE,
    AMOTION_EVENT_ACTION_POINTER_UP, AMOTION_EVENT_ACTION_UP,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(super) struct Ui {
    owner: ActivityId,
    activity: GlobalRef,
    prefs: GlobalRef,
    output: GlobalRef,
    provider: GlobalRef,
    pub sensors: Sensors,
    pub tracking: Tracking,
    hub: Arc<Hub>,
    status: GlobalRef,
    hint: GlobalRef,
    address: GlobalRef,
    source_detail: GlobalRef,
    retry: GlobalRef,
    input: GlobalRef,
    hold: GlobalRef,
    gripper: GlobalRef,
    gripper_value: GlobalRef,
    deadman_pointer: Option<i32>,
    gripper_pointer: Option<i32>,
    last_deadman: Option<(bool, bool)>,
    last_motion: Option<(Motion, TrackingMode, bool)>,
    last_progress: Option<i32>,
    last_source: String,
    last_address: String,
    next_address_check: Instant,
    listeners: Vec<JniProxy>,
    refresh: JniProxy,
    resumed: bool,
    focused: bool,
}

struct Resources {
    table: GlobalRef,
    package: GlobalRef,
}
impl Resources {
    fn id(&self, env: &mut JNIEnv, kind: &str, name: &str) -> Result<i32> {
        let name = env.new_string(name)?;
        let kind = env.new_string(kind)?;
        let id = env
            .call_method(
                &self.table,
                "getIdentifier",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)I",
                &[(&name).into(), (&kind).into(), self.package.as_obj().into()],
            )?
            .i()?;
        if id == 0 {
            return Err(jni::errors::Error::NullPtr("operator resource"));
        }
        Ok(id)
    }
}

impl Ui {
    pub fn create(
        env: &mut JNIEnv,
        activity: &JObject,
        saved_flags: u8,
        owner: ActivityId,
    ) -> Result<Self> {
        let window = env
            .call_method(activity, "getWindow", "()Landroid/view/Window;", &[])?
            .l()?;
        // NativeActivity takes both before loading us. ViewRoot needs them back before attach.
        env.call_method(
            &window,
            "takeSurface",
            "(Landroid/view/SurfaceHolder$Callback2;)V",
            &[(&JObject::null()).into()],
        )?;
        env.call_method(
            &window,
            "takeInputQueue",
            "(Landroid/view/InputQueue$Callback;)V",
            &[(&JObject::null()).into()],
        )?;
        let table = env
            .call_method(
                activity,
                "getResources",
                "()Landroid/content/res/Resources;",
                &[],
            )?
            .l()?;
        let package = env
            .call_method(activity, "getPackageName", "()Ljava/lang/String;", &[])?
            .l()?;
        let resources = Resources {
            table: env.new_global_ref(table)?,
            package: env.new_global_ref(package)?,
        };
        let layout = resources.id(env, "layout", "operator")?;
        env.call_method(activity, "setContentView", "(I)V", &[layout.into()])?;
        let view = |env: &mut JNIEnv, name| -> Result<GlobalRef> {
            let id = resources.id(env, "id", name)?;
            let v = env
                .call_method(
                    activity,
                    "findViewById",
                    "(I)Landroid/view/View;",
                    &[id.into()],
                )?
                .l()?;
            env.new_global_ref(v)
        };
        // Keep the private preference file used by the previous Activity.getPreferences().
        let file = env.new_string("dev.xroperator.phone.MainActivity")?;
        let prefs = env
            .call_method(
                activity,
                "getSharedPreferences",
                "(Ljava/lang/String;I)Landroid/content/SharedPreferences;",
                &[(&file).into(), 0.into()],
            )?
            .l()?;
        let selection = read_selection(env, &prefs)?;
        let output = view(env, "output")?;
        let provider = view(env, "provider")?;
        for (spinner, value) in [
            (&output, selection.output as i32),
            (&provider, selection.provider as i32),
        ] {
            env.call_method(spinner, "setSelection", "(I)V", &[value.into()])?;
        }
        let sensors = Sensors::new(env, activity)?;
        super::start(sensors.mask());
        let hub = super::hub();
        let tracking = Tracking::new(selection, saved_flags, hub.clone());
        let mut ui = Self {
            owner,
            activity: env.new_global_ref(activity)?,
            prefs: env.new_global_ref(prefs)?,
            output: output.clone(),
            provider: provider.clone(),
            sensors,
            tracking,
            hub,
            status: view(env, "status")?,
            hint: view(env, "hint")?,
            address: view(env, "address")?,
            source_detail: view(env, "source_detail")?,
            retry: view(env, "retry")?,
            input: view(env, "input")?,
            hold: view(env, "hold")?,
            gripper: view(env, "gripper")?,
            gripper_value: view(env, "gripper_value")?,
            deadman_pointer: None,
            gripper_pointer: None,
            last_deadman: None,
            last_motion: None,
            last_progress: None,
            last_source: String::new(),
            last_address: String::new(),
            next_address_check: Instant::now(),
            listeners: Vec::new(),
            refresh: JniProxy::build(env, None, ["java/lang/Runnable"], move |env, _, _| {
                owner.with_active_ui(|ui| ui.refresh(env))?;
                JniProxy::void(env)
            })?,
            resumed: false,
            focused: false,
        };
        for (spinner, is_output) in [(output, true), (provider, false)] {
            ui.listen(
                env,
                "android/widget/AdapterView$OnItemSelectedListener",
                &spinner,
                "setOnItemSelectedListener",
                move |ui, env, args| {
                    if let [_, _, position, _] = args {
                        let value = env.call_method(*position, "intValue", "()I", &[])?.i()?;
                        let current = ui.tracking.selection;
                        let (output, provider) = if is_output {
                            (value, current.provider as i32)
                        } else {
                            (current.output as i32, value)
                        };
                        ui.select(env, Selection::from_preferences(0, output, provider))?;
                    }
                    Ok(())
                },
            )?;
        }
        ui.listen(
            env,
            "java/lang/Runnable",
            &ui.activity.clone(),
            "setCameraPermissionListener",
            |ui, _, _| {
                ui.tracking.check_soon();
                Ok(())
            },
        )?;
        let recenter = view(env, "recenter")?;
        ui.listen(
            env,
            "android/view/View$OnClickListener",
            &recenter,
            "setOnClickListener",
            |ui, env, _| {
                ui.action(Action::Recenter);
                ui.render_controls(env)
            },
        )?;
        let input = ui.input.clone();
        let hub = ui.hub.clone();
        let watcher = JniProxy::build(
            env,
            None,
            ["android/text/TextWatcher"],
            move |env, _, args| {
                // afterTextChanged is the only TextWatcher method with one argument.
                if let [editable] = args
                    && owner.is_active()
                {
                    let value = JString::from(
                        env.call_method(*editable, "toString", "()Ljava/lang/String;", &[])?
                            .l()?,
                    );
                    let value: String = env.get_string(&value)?.into();
                    let error = match value.parse::<i32>() {
                        Ok(number) => {
                            hub.action(Action::SetInput(number), phone::now());
                            JObject::null()
                        }
                        Err(_) => env.new_string("Enter a signed 32-bit integer")?.into(),
                    };
                    env.call_method(
                        &input,
                        "setError",
                        "(Ljava/lang/CharSequence;)V",
                        &[(&error).into()],
                    )?;
                }
                JniProxy::void(env)
            },
        )?;
        env.call_method(
            &ui.input,
            "addTextChangedListener",
            "(Landroid/text/TextWatcher;)V",
            &[watcher.as_ref().into()],
        )?;
        ui.listeners.push(watcher);
        // Native keyboard and accessibility adjustments also command the gripper.
        let hub = ui.hub.clone();
        let progress = JniProxy::build(
            env,
            None,
            ["android/widget/SeekBar$OnSeekBarChangeListener"],
            move |env, _, args| {
                if let [_, progress, from_user] = args
                    && owner.is_active()
                    && env
                        .call_method(*from_user, "booleanValue", "()Z", &[])?
                        .z()?
                {
                    let value = env.call_method(*progress, "intValue", "()I", &[])?.i()?;
                    hub.action(Action::SetTrigger(f64::from(value) / 100.0), phone::now());
                }
                JniProxy::void(env)
            },
        )?;
        env.call_method(
            &ui.gripper,
            "setOnSeekBarChangeListener",
            "(Landroid/widget/SeekBar$OnSeekBarChangeListener;)V",
            &[progress.as_ref().into()],
        )?;
        ui.listeners.push(progress);
        ui.listen(
            env,
            "android/view/View$OnClickListener",
            &ui.retry.clone(),
            "setOnClickListener",
            |ui, env, _| ui.tracking.retry(env, ui.activity.as_obj()),
        )?;
        let drawer = view(env, "drawer")?;
        let panel = view(env, "settings_panel")?;
        for (button, method) in [
            ("open_settings", "openDrawer"),
            ("close_settings", "closeDrawer"),
        ] {
            let button = view(env, button)?;
            let drawer = drawer.clone();
            let panel = panel.clone();
            ui.listen(
                env,
                "android/view/View$OnClickListener",
                &button,
                "setOnClickListener",
                move |ui, env, _| {
                    ui.cancel_contact();
                    ui.render_controls(env)?;
                    env.call_method(
                        &drawer,
                        method,
                        "(Landroid/view/View;)V",
                        &[panel.as_obj().into()],
                    )?;
                    Ok(())
                },
            )?;
        }
        for (view, gripper) in [(&ui.hold, false), (&ui.gripper, true)] {
            let listener = JniProxy::build(
                env,
                None,
                ["android/view/View$OnTouchListener"],
                move |env, _, args| {
                    if let [view, event] = args {
                        owner.with_active_ui(|ui| ui.touch(env, view, event, gripper))?;
                    }
                    true.new_jobject(env)
                },
            )?;
            env.call_method(
                view,
                "setOnTouchListener",
                "(Landroid/view/View$OnTouchListener;)V",
                &[listener.as_ref().into()],
            )?;
            ui.listeners.push(listener);
        }
        Ok(ui)
    }
    fn listen(
        &mut self,
        env: &mut JNIEnv,
        interface: &str,
        view: &GlobalRef,
        setter: &str,
        callback: impl Fn(&mut Ui, &mut JNIEnv, &[&JObject]) -> Result<()> + Send + Sync + 'static,
    ) -> Result<()> {
        let owner = self.owner;
        let listener = JniProxy::build(env, None, [interface], move |env, _, args| {
            owner.with_active_ui(|ui| callback(ui, env, args))?;
            JniProxy::void(env)
        })?;
        env.call_method(
            view,
            setter,
            format!("(L{interface};)V"),
            &[listener.as_ref().into()],
        )?;
        self.listeners.push(listener);
        Ok(())
    }
    pub fn detach(&mut self, env: &mut JNIEnv) -> Result<()> {
        if self.resumed {
            self.pause(env)?;
        }
        env.call_method(
            &self.activity,
            "setCameraPermissionListener",
            "(Ljava/lang/Runnable;)V",
            &[(&JObject::null()).into()],
        )?;
        // Detachment can deliver a final ACTION_CANCEL after Activity.onDestroy.
        // Remove the boolean-returning proxy while its handler is still alive.
        for view in [&self.hold, &self.gripper] {
            env.call_method(
                view,
                "setOnTouchListener",
                "(Landroid/view/View$OnTouchListener;)V",
                &[(&JObject::null()).into()],
            )?;
        }
        Ok(())
    }
    fn action(&self, action: Action) {
        self.hub.action(action, phone::now());
    }

    fn touch(
        &mut self,
        env: &mut JNIEnv,
        view: &JObject,
        event: &JObject,
        gripper: bool,
    ) -> Result<()> {
        let action = env.call_method(event, "getActionMasked", "()I", &[])?.i()? as u32;
        let pointer = if gripper {
            &mut self.gripper_pointer
        } else {
            &mut self.deadman_pointer
        };
        if action == AMOTION_EVENT_ACTION_CANCEL {
            *pointer = None;
            if !gripper {
                self.action(Action::Cancel);
            }
            return self.render_controls(env);
        }
        // The layout sends each thumb to its own View. Keep its pointer ID even
        // when a second finger lands on the same View or Android renumbers indices.
        if action == AMOTION_EVENT_ACTION_DOWN {
            if !self.focused {
                return Ok(());
            }
            let parent = env
                .call_method(view, "getParent", "()Landroid/view/ViewParent;", &[])?
                .l()?;
            env.call_method(
                parent,
                "requestDisallowInterceptTouchEvent",
                "(Z)V",
                &[true.into()],
            )?;
            *pointer = Some(
                env.call_method(event, "getPointerId", "(I)I", &[0.into()])?
                    .i()?,
            );
            if !gripper {
                self.hub.action(Action::Hold, phone::now());
            }
        }
        let Some(id) = *pointer else { return Ok(()) };
        let index = env
            .call_method(event, "findPointerIndex", "(I)I", &[id.into()])?
            .i()?;
        let up = matches!(
            action,
            AMOTION_EVENT_ACTION_UP | AMOTION_EVENT_ACTION_POINTER_UP
        );
        if index < 0 {
            *pointer = None;
            if !gripper {
                self.action(Action::Cancel);
            }
            return self.render_controls(env);
        }
        if up && env.call_method(event, "getActionIndex", "()I", &[])?.i()? != index {
            return Ok(());
        }
        if action == AMOTION_EVENT_ACTION_DOWN || action == AMOTION_EVENT_ACTION_MOVE || up {
            let x = env
                .call_method(event, "getX", "(I)F", &[index.into()])?
                .f()?;
            let width = env.call_method(view, "getWidth", "()I", &[])?.i()?;
            if gripper {
                let left = env.call_method(view, "getPaddingLeft", "()I", &[])?.i()?;
                let right = env.call_method(view, "getPaddingRight", "()I", &[])?.i()?;
                let span = (width - left - right).max(1);
                let value = ((f64::from(x) - f64::from(left)) / f64::from(span)).clamp(0.0, 1.0);
                self.hub.action(
                    Action::SetTrigger((value * 100.0).round() / 100.0),
                    phone::now(),
                );
                if up {
                    *pointer = None;
                }
            } else if up {
                *pointer = None;
                self.action(Action::Release);
                env.call_method(view, "performClick", "()Z", &[])?;
            } else {
                let height = env.call_method(view, "getHeight", "()I", &[])?.i()? as f32;
                let inside = |x, y| (0.0..width as f32).contains(&x) && (0.0..height).contains(&y);
                let y = env
                    .call_method(event, "getY", "(I)F", &[index.into()])?
                    .f()?;
                let mut escaped = !inside(x, y);
                for sample in 0..env.call_method(event, "getHistorySize", "()I", &[])?.i()? {
                    let args = [index.into(), sample.into()];
                    let x = env
                        .call_method(event, "getHistoricalX", "(II)F", &args)?
                        .f()?;
                    let y = env
                        .call_method(event, "getHistoricalY", "(II)F", &args)?
                        .f()?;
                    escaped |= !inside(x, y);
                }
                if escaped {
                    *pointer = None;
                    self.action(Action::Cancel);
                }
            }
        }
        self.render_controls(env)
    }
    fn cancel_contact(&mut self) {
        self.deadman_pointer = None;
        self.gripper_pointer = None;
        self.action(Action::Cancel);
    }
    fn select(&mut self, env: &mut JNIEnv, selection: Selection) -> Result<()> {
        if self.tracking.selection == selection {
            return Ok(());
        }
        let editor = env
            .call_method(
                &self.prefs,
                "edit",
                "()Landroid/content/SharedPreferences$Editor;",
                &[],
            )?
            .l()?;
        for (name, value) in [
            ("output", selection.output as i32),
            ("provider", selection.provider as i32),
        ] {
            let key = env.new_string(name)?;
            env.call_method(
                &editor,
                "putInt",
                "(Ljava/lang/String;I)Landroid/content/SharedPreferences$Editor;",
                &[(&key).into(), value.into()],
            )?;
        }
        env.call_method(editor, "apply", "()V", &[])?;
        self.cancel_contact();
        self.tracking.select(selection);
        self.render_controls(env)
    }
    pub fn resume(&mut self, env: &mut JNIEnv) -> Result<()> {
        self.resumed = true;
        // An overlapping activity can change the process-wide operator's saved choices.
        let selection = read_selection(env, self.prefs.as_obj())?;
        if selection != self.tracking.selection {
            self.tracking.selection = selection;
            for (spinner, value) in [
                (&self.output, selection.output as i32),
                (&self.provider, selection.provider as i32),
            ] {
                env.call_method(spinner, "setSelection", "(I)V", &[value.into()])?;
            }
        }
        let input = self.hub.handset_status(phone::now()).input;
        set_text(env, &self.input, &input.to_string())?;
        self.action(Action::Resume);
        self.action(Action::Focus(self.focused));
        let registered = self.sensors.resume(env, self.hub.clone())?;
        self.tracking.resume(registered);
        self.refresh(env)
    }
    pub fn pause(&mut self, env: &mut JNIEnv) -> Result<()> {
        self.resumed = false;
        self.deadman_pointer = None;
        self.gripper_pointer = None;
        self.action(Action::Pause);
        self.tracking.stop();
        self.sensors.pause(env)?;
        env.call_method(
            &self.hold,
            "removeCallbacks",
            "(Ljava/lang/Runnable;)Z",
            &[self.refresh.as_ref().into()],
        )?;
        Ok(())
    }
    pub fn focus(&mut self, focused: bool) {
        self.focused = focused;
        if !self.resumed {
            return;
        }
        self.action(Action::Focus(focused));
        if focused {
            self.tracking.check_soon();
        } else {
            self.deadman_pointer = None;
            self.gripper_pointer = None;
            self.tracking.stop();
        }
    }
    fn render_controls(&mut self, env: &mut JNIEnv) -> Result<()> {
        let state = self.hub.handset_status(phone::now());
        let contact = self.deadman_pointer.is_some();
        if self.last_deadman != Some((contact, state.held)) {
            env.call_method(&self.hold, "setPressed", "(Z)V", &[contact.into()])?;
            env.call_method(&self.hold, "setActivated", "(Z)V", &[state.held.into()])?;
            let (label, description) = if state.held {
                ("Deadman\nHeld", "Held")
            } else if contact {
                ("Deadman\nLift to retry", "Pressed, inactive")
            } else {
                ("Deadman\nPress and hold", "Released")
            };
            set_text(env, &self.hold, label)?;
            let description = env.new_string(description)?;
            env.call_method(
                &self.hold,
                "setStateDescription",
                "(Ljava/lang/CharSequence;)V",
                &[(&description).into()],
            )?;
            self.last_deadman = Some((contact, state.held));
        }
        let progress = (state.trigger * 100.0).round() as i32;
        if self.last_progress != Some(progress) {
            env.call_method(&self.gripper, "setProgress", "(I)V", &[progress.into()])?;
            let value = format!("{:.2}", f64::from(progress) / 100.0);
            set_text(env, &self.gripper_value, &value)?;
            let description = env.new_string(value)?;
            env.call_method(
                &self.gripper,
                "setStateDescription",
                "(Ljava/lang/CharSequence;)V",
                &[(&description).into()],
            )?;
            self.last_progress = Some(progress);
        }
        let waiting = self.tracking.waiting_for_client();
        let motion = (state.motion, state.mode, waiting);
        if self.last_motion != Some(motion) {
            let (title, hint) = match (state.motion, state.mode) {
                (_, TrackingMode::Unavailable) if waiting => (
                    "Waiting for a client",
                    "Connect a viewer to start camera tracking.",
                ),
                (Motion::Unavailable, _) | (_, TrackingMode::Unavailable) => {
                    ("Tracking unavailable", "Choose another tracking source.")
                }
                (Motion::OrientationOnly, _) => (
                    "Tracking rotation only",
                    "Using IMU orientation while position is unavailable.",
                ),
                (Motion::Calibrating, TrackingMode::Camera { .. }) => (
                    "Locating the camera",
                    "Move slowly near a well-lit, textured surface.",
                ),
                (Motion::Calibrating, _) => (
                    "Calibrating motion sensors",
                    "Keep the phone still for a moment.",
                ),
                (Motion::Recovering, _) => (
                    "Recovering tracking",
                    "Move slowly while tracking recovers.",
                ),
                (Motion::Waiting, TrackingMode::Camera { .. }) => (
                    "Waiting for camera",
                    "Move slowly near a well-lit, textured surface.",
                ),
                (Motion::Waiting, _) => (
                    "Waiting for sensors",
                    "Waiting for fresh motion measurements.",
                ),
                (Motion::Ready, _) => ("Tracking ready", "Waiting for a fresh pose."),
                (
                    Motion::Tracking,
                    TrackingMode::Orientation
                    | TrackingMode::Camera {
                        output: Output::OrientationOnly,
                        ..
                    },
                ) => ("Tracking rotation", "Recenter sets the current heading."),
                (
                    Motion::Tracking,
                    TrackingMode::Camera {
                        output: Output::FullPose,
                        ..
                    },
                ) => (
                    "Tracking position and rotation",
                    "Recenter sets the current location and heading.",
                ),
                (Motion::Tracking, TrackingMode::Displacement) => (
                    "Estimating position and rotation",
                    "Recenter sets the current location and heading.",
                ),
            };
            set_text(env, &self.status, title)?;
            set_text(env, &self.hint, hint)?;
            self.last_motion = Some(motion);
        }
        Ok(())
    }
    fn refresh(&mut self, env: &mut JNIEnv) -> Result<()> {
        if !self.resumed {
            return Ok(());
        }
        if self.focused {
            self.tracking.update(env, &self.activity)?;
        }
        self.render_controls(env)?;
        let source = self
            .hub
            .camera_status(phone::now())
            .unwrap_or_else(|| self.tracking.message.clone());
        if source != self.last_source {
            set_text(env, &self.source_detail, &source)?;
            self.last_source = source;
        }
        if Instant::now() >= self.next_address_check {
            let address = super::operator_address();
            if self.last_address != address {
                set_text(env, &self.address, &address)?;
                self.last_address = address;
            }
            self.next_address_check = Instant::now() + Duration::from_secs(2);
        }
        let visibility = if self.tracking.retry_action.is_some() {
            0
        } else {
            8
        };
        env.call_method(&self.retry, "setVisibility", "(I)V", &[visibility.into()])?;
        env.call_method(
            &self.hold,
            "postDelayed",
            "(Ljava/lang/Runnable;J)Z",
            &[self.refresh.as_ref().into(), 100_i64.into()],
        )?;
        Ok(())
    }
}

fn read_selection(env: &mut JNIEnv, prefs: &JObject) -> Result<Selection> {
    let read = |env: &mut JNIEnv, name| -> Result<i32> {
        let key = env.new_string(name)?;
        env.call_method(
            prefs,
            "getInt",
            "(Ljava/lang/String;I)I",
            &[(&key).into(), (-1).into()],
        )?
        .i()
    };
    Ok(Selection::from_preferences(
        read(env, "tracking")?,
        read(env, "output")?,
        read(env, "provider")?,
    ))
}

fn set_text(env: &mut JNIEnv, view: &GlobalRef, value: &str) -> Result<()> {
    let text = env.new_string(value)?;
    env.call_method(
        view,
        "setText",
        "(Ljava/lang/CharSequence;)V",
        &[(&text).into()],
    )?;
    Ok(())
}
