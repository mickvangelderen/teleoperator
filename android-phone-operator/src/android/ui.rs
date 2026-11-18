//! Framework Views, inflated and updated on the Activity's main looper.
use super::{activity::with_ui, camera::Tracking, sensors::Sensors};
use crate::phone::{self, Action, Hand, Hub};
use jni::{
    JNIEnv,
    errors::Result,
    objects::{GlobalRef, JObject},
};
use jni_min_helper::{JObjectNew, JniProxy};
use ndk_sys::{
    AMOTION_EVENT_ACTION_CANCEL, AMOTION_EVENT_ACTION_DOWN, AMOTION_EVENT_ACTION_MOVE,
    AMOTION_EVENT_ACTION_POINTER_DOWN, AMOTION_EVENT_ACTION_POINTER_UP, AMOTION_EVENT_ACTION_UP,
};
use std::sync::Arc;

pub(super) struct Ui {
    activity: GlobalRef,
    prefs: GlobalRef,
    pub sensors: Sensors,
    pub tracking: Tracking,
    hub: Arc<Hub>,
    status: GlobalRef,
    retry: GlobalRef,
    hands: [GlobalRef; 2],
    hold: GlobalRef,
    hold_labels: [i32; 2],
    last_held: Option<bool>,
    last_hand: Option<Hand>,
    last_status: String,
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
    pub fn create(env: &mut JNIEnv, activity: &JObject, saved_flags: u8) -> Result<Self> {
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
        let notice = view(env, "notice")?;
        let links = env
            .call_static_method(
                "android/text/method/LinkMovementMethod",
                "getInstance",
                "()Landroid/text/method/MovementMethod;",
                &[],
            )?
            .l()?;
        env.call_method(
            &notice,
            "setMovementMethod",
            "(Landroid/text/method/MovementMethod;)V",
            &[(&links).into()],
        )?;

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
        let key = env.new_string("tracking")?;
        let source = env
            .call_method(
                &prefs,
                "getInt",
                "(Ljava/lang/String;I)I",
                &[(&key).into(), 0.into()],
            )?
            .i()?;
        let source = if (0..3).contains(&source) { source } else { 0 };
        let spinner = view(env, "source")?;
        env.call_method(&spinner, "setSelection", "(I)V", &[source.into()])?;
        let sensors = Sensors::new(env, activity)?;
        super::start(sensors.mask());
        let hub = super::hub();
        let tracking = Tracking::new(source, sensors.mask(), saved_flags, hub.clone());
        let mut ui = Self {
            activity: env.new_global_ref(activity)?,
            prefs: env.new_global_ref(prefs)?,
            sensors,
            tracking,
            hub,
            status: view(env, "status")?,
            retry: view(env, "retry")?,
            hands: [view(env, "left")?, view(env, "right")?],
            hold: view(env, "hold")?,
            hold_labels: [
                resources.id(env, "string", "hold")?,
                resources.id(env, "string", "held")?,
            ],
            last_held: None,
            last_hand: None,
            last_status: String::new(),
            listeners: Vec::new(),
            refresh: JniProxy::build(env, None, ["java/lang/Runnable"], |env, _, _| {
                with_ui(|ui| ui.refresh(env))?;
                JniProxy::void(env)
            })?,
            resumed: false,
            focused: false,
        };
        ui.listen(
            env,
            "android/widget/AdapterView$OnItemSelectedListener",
            &spinner,
            "setOnItemSelectedListener",
            |env, args| {
                if let [_, _, position, _] = args {
                    let source = env.call_method(*position, "intValue", "()I", &[])?.i()?;
                    with_ui(|ui| ui.select(env, source))?;
                }
                Ok(())
            },
        )?;
        for (v, action) in [
            (ui.hands[0].clone(), Action::Select(Hand::Left)),
            (ui.hands[1].clone(), Action::Select(Hand::Right)),
            (view(env, "recenter")?, Action::Recenter),
        ] {
            ui.listen(
                env,
                "android/view/View$OnClickListener",
                &v,
                "setOnClickListener",
                move |_, _| {
                    with_ui(|ui| {
                        ui.action(action);
                        Ok(())
                    })
                },
            )?;
        }
        ui.listen(
            env,
            "android/view/View$OnClickListener",
            &ui.retry.clone(),
            "setOnClickListener",
            |env, _| with_ui(|ui| ui.tracking.retry(env, ui.activity.as_obj())),
        )?;
        let hold = JniProxy::build(
            env,
            None,
            ["android/view/View$OnTouchListener"],
            |env, _, args| {
                if let [view, event] = args {
                    with_ui(|ui| ui.touch(env, view, event))?;
                }
                true.new_jobject(env)
            },
        )?;
        env.call_method(
            &ui.hold,
            "setOnTouchListener",
            "(Landroid/view/View$OnTouchListener;)V",
            &[hold.as_ref().into()],
        )?;
        ui.listeners.push(hold);
        Ok(ui)
    }
    fn listen(
        &mut self,
        env: &mut JNIEnv,
        interface: &str,
        view: &GlobalRef,
        setter: &str,
        callback: impl Fn(&mut JNIEnv, &[&JObject]) -> Result<()> + Send + Sync + 'static,
    ) -> Result<()> {
        let listener = JniProxy::build(env, None, [interface], move |env, _, args| {
            callback(env, args)?;
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
    pub fn detach(&self, env: &mut JNIEnv) -> Result<()> {
        // Detachment can deliver a final ACTION_CANCEL after Activity.onDestroy.
        // Remove the boolean-returning proxy while its handler is still alive.
        env.call_method(
            &self.hold,
            "setOnTouchListener",
            "(Landroid/view/View$OnTouchListener;)V",
            &[(&JObject::null()).into()],
        )?;
        Ok(())
    }
    fn action(&self, action: Action) {
        self.hub.action(action, phone::now());
    }

    fn touch(&self, env: &mut JNIEnv, view: &JObject, event: &JObject) -> Result<()> {
        match env.call_method(event, "getActionMasked", "()I", &[])?.i()? as u32 {
            AMOTION_EVENT_ACTION_DOWN => {
                let parent = env
                    .call_method(view, "getParent", "()Landroid/view/ViewParent;", &[])?
                    .l()?;
                env.call_method(
                    parent,
                    "requestDisallowInterceptTouchEvent",
                    "(Z)V",
                    &[true.into()],
                )?;
                self.action(Action::Hold);
            }
            AMOTION_EVENT_ACTION_MOVE if self.hub.held() => {
                let width = env.call_method(view, "getWidth", "()I", &[])?.i()? as f32;
                let height = env.call_method(view, "getHeight", "()I", &[])?.i()? as f32;
                let inside = |x, y| (0.0..width).contains(&x) && (0.0..height).contains(&y);
                let x = env.call_method(event, "getX", "()F", &[])?.f()?;
                let y = env.call_method(event, "getY", "()F", &[])?.f()?;
                if !inside(x, y) {
                    self.action(Action::Cancel);
                } else {
                    for i in 0..env.call_method(event, "getHistorySize", "()I", &[])?.i()? {
                        let x = env
                            .call_method(event, "getHistoricalX", "(I)F", &[i.into()])?
                            .f()?;
                        let y = env
                            .call_method(event, "getHistoricalY", "(I)F", &[i.into()])?
                            .f()?;
                        if !inside(x, y) {
                            self.action(Action::Cancel);
                            break;
                        }
                    }
                }
            }
            AMOTION_EVENT_ACTION_UP => {
                self.action(Action::Release);
                env.call_method(view, "performClick", "()Z", &[])?;
            }
            AMOTION_EVENT_ACTION_CANCEL
            | AMOTION_EVENT_ACTION_POINTER_DOWN
            | AMOTION_EVENT_ACTION_POINTER_UP => self.action(Action::Cancel),
            _ => {}
        }
        Ok(())
    }
    fn select(&mut self, env: &mut JNIEnv, source: i32) -> Result<()> {
        if self.tracking.source == source {
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
        let key = env.new_string("tracking")?;
        env.call_method(
            &editor,
            "putInt",
            "(Ljava/lang/String;I)Landroid/content/SharedPreferences$Editor;",
            &[(&key).into(), source.into()],
        )?;
        env.call_method(editor, "apply", "()V", &[])?;
        self.tracking.select(source);
        Ok(())
    }
    pub fn resume(&mut self, env: &mut JNIEnv) -> Result<()> {
        self.resumed = true;
        self.action(Action::Resume);
        self.tracking.check_soon();
        self.sensors.resume(env, self.hub.clone())?;
        self.refresh(env)
    }
    pub fn pause(&mut self, env: &mut JNIEnv) -> Result<()> {
        self.resumed = false;
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
        self.action(Action::Focus(focused));
        if focused {
            self.tracking.check_soon();
        } else {
            self.tracking.stop();
        }
    }
    fn refresh(&mut self, env: &mut JNIEnv) -> Result<()> {
        if !self.resumed {
            return Ok(());
        }
        if self.focused {
            self.tracking.update(env, &self.activity)?;
        }
        let status = format!("{}\n\n{}", self.tracking.message, super::status());
        if status != self.last_status {
            let text = env.new_string(&status)?;
            env.call_method(
                &self.status,
                "setText",
                "(Ljava/lang/CharSequence;)V",
                &[(&text).into()],
            )?;
            self.last_status = status;
        }
        let hand = self.hub.selected();
        if self.last_hand != Some(hand) {
            env.call_method(
                &self.hands[hand as usize],
                "setChecked",
                "(Z)V",
                &[true.into()],
            )?;
            self.last_hand = Some(hand);
        }
        let held = self.hub.held();
        if self.last_held != Some(held) {
            env.call_method(
                &self.hold,
                "setText",
                "(I)V",
                &[self.hold_labels[usize::from(held)].into()],
            )?;
            env.call_method(&self.hold, "setActivated", "(Z)V", &[held.into()])?;
            let label = env
                .call_method(&self.hold, "getText", "()Ljava/lang/CharSequence;", &[])?
                .l()?;
            env.call_method(
                &self.hold,
                "setStateDescription",
                "(Ljava/lang/CharSequence;)V",
                &[(&label).into()],
            )?;
            self.last_held = Some(held);
        }
        let visibility = if self.tracking.retry_visible { 0 } else { 8 };
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
