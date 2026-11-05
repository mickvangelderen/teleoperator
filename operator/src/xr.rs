use crate::tracking::{Hub, Pose, RATE};
use android_activity::{AndroidApp, InputStatus, MainEvent, PollEvent};
use openxr as xr;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use xr::sys::Handle;

pub fn run(app: &AndroidApp, hub: Arc<Hub>) -> Result<(), Box<dyn std::error::Error>> {
    let platform = unsafe { xr::AndroidPlatformInfo::new(app.vm_as_ptr(), app.activity_as_ptr()) };
    let entry = unsafe { xr::Entry::load(&platform) }?;
    let available = entry.enumerate_extensions()?;
    let mut extensions = xr::ExtensionSet::default();
    extensions.khr_android_create_instance = true;
    extensions.khr_opengl_es_enable = true;
    extensions.khr_convert_timespec_time = true;
    extensions.ext_local_floor = available.ext_local_floor;
    extensions.fb_passthrough = available.fb_passthrough;
    extensions.fb_body_tracking = available.fb_body_tracking;
    extensions.meta_body_tracking_fidelity = available.meta_body_tracking_fidelity;
    extensions.meta_body_tracking_calibration = available.meta_body_tracking_calibration;
    if !extensions.fb_passthrough {
        return Err("Runtime does not support passthrough".into());
    }
    let instance = entry.create_instance(
        &xr::ApplicationInfo {
            application_name: "XR Operator",
            application_version: 1,
            engine_name: "",
            engine_version: 0,
            api_version: xr::Version::new(1, 0, 0),
        },
        &extensions,
        &[],
        &platform,
    )?;
    log::info!("OpenXR runtime: {:?}", instance.properties()?);
    let system = instance.system(xr::FormFactor::HEAD_MOUNTED_DISPLAY)?;
    instance.graphics_requirements::<xr::OpenGlEs>(system)?;
    // The runtime requires a graphics binding even when only submitting passthrough.
    let graphics = crate::egl::Context::new()?;
    let (session, mut waiter, mut frames) = unsafe {
        instance.create_session::<xr::OpenGlEs>(
            system,
            &xr::opengles::SessionCreateInfo::Android {
                display: graphics.display,
                config: graphics.config,
                context: graphics.context,
            },
        )
    }?;
    let actions = instance.create_action_set("tracking", "Tracking", 0)?;
    let hands = [
        instance.string_to_path("/user/hand/left")?,
        instance.string_to_path("/user/hand/right")?,
    ];
    let aim = actions.create_action::<xr::Posef>("aim", "Aim", &hands)?;
    let grip = actions.create_action::<xr::Posef>("grip", "Grip", &hands)?;
    let mut bindings = Vec::new();
    let input_definitions = crate::inputs::definitions();
    let input_actions = input_definitions
        .iter()
        .enumerate()
        .map(|(i, d)| crate::xr_inputs::Action::create(&actions, d, i))
        .collect::<xr::Result<Vec<_>>>()?;
    for (action, definition) in input_actions.iter().zip(input_definitions) {
        bindings.push(action.binding(instance.string_to_path(&format!(
            "/user/hand/{}/input/{}",
            definition.source, definition.path
        ))?));
    }
    for hand in ["left", "right"] {
        for (name, action) in [("aim", &aim), ("grip", &grip)] {
            bindings.push(xr::Binding::new(
                action,
                instance.string_to_path(&format!("/user/hand/{hand}/input/{name}/pose"))?,
            ));
        }
    }
    instance.suggest_interaction_profile_bindings(
        instance.string_to_path("/interaction_profiles/oculus/touch_controller")?,
        &bindings,
    )?;
    session.attach_action_sets(&[&actions])?;
    let base_type = if extensions.ext_local_floor
        && session
            .enumerate_reference_spaces()?
            .contains(&xr::ReferenceSpaceType::LOCAL_FLOOR_EXT)
    {
        xr::ReferenceSpaceType::LOCAL_FLOOR_EXT
    } else {
        xr::ReferenceSpaceType::LOCAL
    };
    let base = session.create_reference_space(base_type, xr::Posef::IDENTITY)?;
    hub.local_floor.store(
        base_type == xr::ReferenceSpaceType::LOCAL_FLOOR_EXT,
        Ordering::SeqCst,
    );
    log::info!("Tracking reference space: {base_type:?}");
    let spaces = [
        session.create_reference_space(xr::ReferenceSpaceType::VIEW, xr::Posef::IDENTITY)?,
        aim.create_space(&session, hands[0], xr::Posef::IDENTITY)?,
        grip.create_space(&session, hands[0], xr::Posef::IDENTITY)?,
        aim.create_space(&session, hands[1], xr::Posef::IDENTITY)?,
        grip.create_space(&session, hands[1], xr::Posef::IDENTITY)?,
    ];
    let passthrough = session.create_passthrough(xr::PassthroughFlagsFB::IS_RUNNING_AT_CREATION)?;
    let layer = session.create_passthrough_layer(
        &passthrough,
        xr::PassthroughFlagsFB::IS_RUNNING_AT_CREATION,
        xr::PassthroughLayerPurposeFB::RECONSTRUCTION,
    )?;
    let gate = Mutex::new((false, Vec::<xr::Time>::new()));
    let stop = AtomicBool::new(false);
    let body_permission = Arc::new(AtomicBool::new(false));
    if extensions.fb_body_tracking {
        crate::xr_body::poll_permission(app, body_permission.clone(), true);
    }
    hub.body_fidelity
        .store(extensions.meta_body_tracking_fidelity, Ordering::SeqCst);
    hub.body_calibration
        .store(extensions.meta_body_tracking_calibration, Ordering::SeqCst);
    hub.set_available(true);
    let result = std::thread::scope(|scope| {
        let sampler = scope.spawn(|| {
            let period = Duration::from_secs_f32(1.0 / RATE);
            let mut next = Instant::now();
            let mut tracker = None;
            let mut retry_body = Instant::now();
            while !stop.load(Ordering::SeqCst) {
                next += period;
                let sampling_started = hub.now();
                let mut state = gate.lock().unwrap();
                let acquired_at = hub.now();
                let (mut inputs_done, mut body_done) = (acquired_at, acquired_at);
                let mut body = hub
                    .skeleton
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|s| crate::body::Body::inactive(s.clone()));
                if !body_permission.load(Ordering::SeqCst) {
                    tracker = None;
                    body = None;
                }
                let mut inputs = input_definitions
                    .iter()
                    .map(|d| crate::inputs::Input::inactive(d.kind))
                    .collect::<Vec<_>>();
                let mut poses: [Pose; 5] = std::array::from_fn(|i| Pose {
                    active: (i > 0).then_some(false),
                    ..Default::default()
                });
                if state.0
                    && let Ok(time) = instance.now()
                {
                    state.1.retain(|change| {
                        if change.as_nanos() <= time.as_nanos() {
                            hub.reset_reference();
                            false
                        } else {
                            true
                        }
                    });
                    let synced = session
                        .sync_actions(&[xr::ActiveActionSet::new(&actions)])
                        .is_ok();
                    for (input, action) in inputs.iter_mut().zip(&input_actions) {
                        *input = action.sample(&session, synced);
                    }
                    inputs_done = hub.now();
                    if extensions.fb_body_tracking
                        && body_permission.load(Ordering::SeqCst)
                        && tracker.is_none()
                        && Instant::now() >= retry_body
                    {
                        retry_body = Instant::now() + Duration::from_secs(1);
                        match crate::xr_body::Tracker::new(
                            &session,
                            extensions.meta_body_tracking_fidelity,
                            extensions.meta_body_tracking_calibration,
                        ) {
                            Ok(created) => tracker = Some(created),
                            Err(error) => log::warn!("Body tracker unavailable: {error}"),
                        }
                    }
                    if let Some(tracker) = &mut tracker
                        && let Ok(sample) = tracker.sample(&base, time, &hub)
                    {
                        body = Some(sample);
                    }
                    body_done = hub.now();
                    for (i, space) in spaces.iter().enumerate() {
                        if i > 0 {
                            let action = if i % 2 == 1 { &aim } else { &grip };
                            poses[i].active = Some(
                                synced
                                    && action
                                        .is_active(&session, hands[(i - 1) / 2])
                                        .unwrap_or(false),
                            );
                        }
                        if (i == 0 || poses[i].active == Some(true))
                            && let Ok(location) = space.locate(&base, time)
                        {
                            let p = location.pose.position;
                            let q = location.pose.orientation;
                            poses[i].position = [p.x, p.y, p.z];
                            poses[i].orientation = [q.x, q.y, q.z, q.w];
                            poses[i].flags = location.location_flags.into_raw() as u16;
                        }
                    }
                }
                // XrTime has a runtime epoch; leave target_at absent until explicitly converted.
                let poses_done = hub.now();
                hub.acquire(&poses, &inputs, body.as_ref(), acquired_at, None);
                drop(state);
                hub.trace.record(
                    hub.now(),
                    crate::diagnostics::Event::XrSample {
                        start_ms: sampling_started as f64 / 1e6,
                        locked_ms: acquired_at as f64 / 1e6,
                        inputs_ms: inputs_done as f64 / 1e6,
                        body_ms: body_done as f64 / 1e6,
                        poses_ms: poses_done as f64 / 1e6,
                    },
                );
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        });
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let mut events = xr::EventDataBuffer::new();
            let mut alive = true;
            let mut has_run = false;
            let mut permission_poll = Instant::now();
            while alive {
                if extensions.fb_body_tracking && Instant::now() >= permission_poll {
                    permission_poll = Instant::now() + Duration::from_secs(1);
                    crate::xr_body::poll_permission(app, body_permission.clone(), false);
                }
                let running = gate.lock().unwrap().0;
                app.poll_events(
                    Some(Duration::from_millis(if running { 0 } else { 20 })),
                    |event| {
                        if let PollEvent::Main(event) = event {
                            match event {
                                MainEvent::Destroy => alive = false,
                                MainEvent::InputAvailable => {
                                    if let Ok(mut events) = app.input_events_iter() {
                                        while events.next(|_| InputStatus::Unhandled) {}
                                    }
                                }
                                _ => {}
                            }
                        }
                    },
                );
                while let Some(event) = instance.poll_event(&mut events)? {
                    match event {
                        xr::Event::SessionStateChanged(event) => {
                            log::info!("OpenXR session: {:?}", event.state());
                            let mut state = gate.lock().unwrap();
                            match event.state() {
                                xr::SessionState::READY => {
                                    session.begin(xr::ViewConfigurationType::PRIMARY_STEREO)?;
                                    if has_run {
                                        hub.reset_reference();
                                        hub.resumed_at.store(hub.now(), Ordering::SeqCst);
                                    }
                                    has_run = true;
                                    state.0 = true;
                                }
                                xr::SessionState::STOPPING => {
                                    state.0 = false;
                                    session.end()?;
                                }
                                xr::SessionState::EXITING | xr::SessionState::LOSS_PENDING => {
                                    alive = false
                                }
                                _ => {}
                            }
                        }
                        xr::Event::ReferenceSpaceChangePending(event)
                            if event.reference_space_type() == base_type =>
                        {
                            gate.lock().unwrap().1.push(event.change_time())
                        }
                        xr::Event::InstanceLossPending(_) => alive = false,
                        _ => {}
                    }
                }
                if !alive || !gate.lock().unwrap().0 {
                    continue;
                }
                let frame = waiter.wait()?;
                frames.begin()?;
                // openxr 0.22 does not export its passthrough composition builder.
                let composition = xr::sys::CompositionLayerPassthroughFB {
                    ty: xr::sys::CompositionLayerPassthroughFB::TYPE,
                    next: std::ptr::null(),
                    flags: xr::CompositionLayerFlags::EMPTY,
                    space: xr::sys::Space::NULL,
                    layer_handle: layer.as_raw(),
                };
                let layers =
                    [(&composition as *const xr::sys::CompositionLayerPassthroughFB).cast()];
                let result = unsafe {
                    (instance.fp().end_frame)(
                        session.as_raw(),
                        &xr::sys::FrameEndInfo {
                            ty: xr::sys::FrameEndInfo::TYPE,
                            next: std::ptr::null(),
                            display_time: frame.predicted_display_time,
                            environment_blend_mode: xr::EnvironmentBlendMode::OPAQUE,
                            layer_count: u32::from(frame.should_render),
                            layers: layers.as_ptr(),
                        },
                    )
                };
                if result.into_raw() < 0 {
                    return Err(result.into());
                }
            }
            Ok(())
        })();
        stop.store(true, Ordering::SeqCst);
        sampler.join().expect("OpenXR acquisition thread panicked");
        result
    });
    hub.set_available(false);
    result
}
