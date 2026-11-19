//! Gamepad state observations, independent of SDL and transport.
//! Snapshots observe the backend's retained state, not new physical measurements.
use crate::protocol::{
    self, Capabilities, Descriptor, EncodedAcquisition, PublicationState, Request, Value,
};
use crate::virtual_pose::{self, VirtualPose};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub const RATE: f32 = 100.;
pub const OBSERVATION_PERIOD_NS: u64 = (1e9 / RATE as f64) as u64;
const HANDOFF_NS: u64 = 1_000_000;
pub struct Clock(Instant);
impl Default for Clock {
    fn default() -> Self {
        Self(Instant::now())
    }
}
impl Clock {
    pub fn now(&self) -> u64 {
        self.0.elapsed().as_nanos().min(i64::MAX as u128) as u64
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum InputValue {
    Button(bool),
    Scalar(f64),
    Stick([f64; 2]),
}
impl InputValue {
    fn zero(&self) -> Self {
        match self {
            Self::Button(_) => Self::Button(false),
            Self::Scalar(_) => Self::Scalar(0.),
            Self::Stick(_) => Self::Stick([0.; 2]),
        }
    }
    fn wire(&self) -> Value {
        match self {
            Self::Button(v) => Value::Bit(*v),
            Self::Scalar(v) => Value::Numbers(vec![*v]),
            Self::Stick(v) => Value::Numbers(v.to_vec()),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Definition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: u8,
}
impl Definition {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        kind: u8,
        description: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            kind,
            description: description.into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mapping: String,
    pub reconnectable: bool,
    pub synthetic: bool,
}
struct Demand {
    request: Request,
    publication: Weak<Mutex<PublicationState>>,
}
struct State {
    virtual_pose: Option<VirtualPose>,
    connected: bool,
    active: Vec<bool>,
    values: Vec<InputValue>,
    presses: Vec<u64>,
    releases: Vec<u64>,
    number: u64,
    at: u64,
    last_nominal: u64,
    retry: Option<(u64, u64)>,
    last_activity: Option<u64>,
    demands: Vec<Demand>,
}
pub struct Hub {
    virtual_unavailable: Option<String>,
    pub capabilities: Arc<Capabilities>,
    pub definitions: Vec<Definition>,
    pub device: DeviceInfo,
    pub updates: watch::Sender<u64>,
    pub retired: watch::Sender<bool>,
    pub clock: Arc<Clock>,
    state: Mutex<State>,
    planned_slot: AtomicU64,
    schedule_changed: Condvar,
}
fn descriptor(
    id: String,
    name: String,
    description: String,
    kind: u8,
    formats: Vec<u8>,
) -> Descriptor {
    Descriptor {
        id,
        name,
        description,
        kind,
        formats,
        group: 0,
        ..Default::default()
    }
}
fn catalog(defs: &[Definition], device: &DeviceInfo) -> Capabilities {
    let mut c = Capabilities {
        groups: vec![RATE],
        ..Default::default()
    };
    for (id, name, desc) in [
        (
            "/gamepad/connected",
            "Connected",
            "True while the selected input backend is attached and readable; false invalidates all inputs.",
        ),
        (
            "/gamepad/activity",
            "Recent input activity",
            "True for one second after an observed value transition; idle inputs remain active. Software processing time, not a physical timestamp.",
        ),
    ] {
        c.descriptors
            .push(descriptor(id.into(), name.into(), desc.into(), 1, vec![1]));
    }
    for d in defs {
        let index = c.descriptors.len() as u32;
        let formats = match d.kind {
            2 => vec![1],
            8 => vec![10, 11, 12, 13],
            9 => vec![10, 11, 14, 15],
            _ => vec![10, 11],
        };
        c.descriptors.push(descriptor(d.id.clone(),d.name.clone(),format!("{} Device: {}; identity: {}; mapping: {}. State observed after draining SDL at up to 100 Hz; timestamp is software observation, not physical report time. Companion {}/active must be true at the same timestamp; otherwise false/zero is a placeholder. No application deadzone or prediction.",d.description,device.name,device.id,device.mapping,d.id),d.kind,formats));
        c.descriptors.push(descriptor(format!("{}/active",d.id),format!("{} active",d.name),format!("Availability of {} at matching observation timestamp. Idle is active. Disconnect does not create release edges.",d.id),1,vec![1]));
        if d.kind == 2 {
            for (suffix, kind) in [("press_count", 3), ("release_count", 4)] {
                c.descriptors.push(descriptor(format!("{}/{suffix}",d.id),format!("{} {suffix}",d.name),"Cumulative observed native transitions within this connection epoch; initial held state, disconnection and reactivation create no edges. Wraps modulo selected width.".into(),kind,vec![2,3,4,5]));
            }
            c.descriptors[index as usize].press_count_sample = Some(index + 2);
            c.descriptors[index as usize].release_count_sample = Some(index + 3);
        }
    }
    c
}
impl State {
    fn wire_values(&self) -> Vec<Value> {
        let mut out = vec![
            Value::Bit(self.connected),
            Value::Bit(
                self.connected
                    && self
                        .last_activity
                        .is_some_and(|at| self.at.saturating_sub(at) < 1_000_000_000),
            ),
        ];
        for (i, v) in self.values.iter().enumerate() {
            out.push(if self.active[i] {
                v.wire()
            } else {
                v.zero().wire()
            });
            out.push(Value::Bit(self.active[i]));
            if matches!(v, InputValue::Button(_)) {
                out.push(Value::Unsigned(self.presses[i]));
                out.push(Value::Unsigned(self.releases[i]));
            }
        }
        if let Some(pose) = &self.virtual_pose {
            out.extend(pose.wire_values());
        }
        out
    }
    fn encode(&self, c: &Capabilities, r: &Request) -> protocol::Result<EncodedAcquisition> {
        let values = self.wire_values();
        let bundles = r
            .bundles
            .iter()
            .map(|bindings| {
                let selected = bindings
                    .iter()
                    .map(|b| {
                        values
                            .get(b.descriptor as usize)
                            .cloned()
                            .ok_or_else(|| "Missing gamepad input".to_string())
                    })
                    .collect::<protocol::Result<Vec<_>>>()?;
                protocol::encode_bundle(c, bindings, &selected)
            })
            .collect::<protocol::Result<Vec<_>>>()?;
        Ok(EncodedAcquisition {
            number: self.number,
            acquired_at: self.at,
            predicted_for: None,
            bundles,
        })
    }
    fn publish(&mut self, c: &Capabilities, at: u64) {
        self.at = self.at.max(at);
        self.number += 1;
        self.demands.retain(|d| d.publication.strong_count() > 0);
        for d in &self.demands {
            if let Some(p) = d.publication.upgrade() {
                let mut p = p.lock().unwrap();
                match self.encode(c, &d.request) {
                    Ok(a) => p.observe(a),
                    Err(e) => p.error = Some(e),
                }
            }
        }
    }
}
impl Hub {
    pub fn new(
        device: DeviceInfo,
        definitions: Vec<Definition>,
        initial: Vec<InputValue>,
        clock: Arc<Clock>,
        at: u64,
    ) -> protocol::Result<Arc<Self>> {
        Self::with_virtual(device, definitions, initial, clock, at, None)
    }
    pub fn with_virtual(
        device: DeviceInfo,
        definitions: Vec<Definition>,
        initial: Vec<InputValue>,
        clock: Arc<Clock>,
        at: u64,
        virtual_config: Option<virtual_pose::Config>,
    ) -> protocol::Result<Arc<Self>> {
        if definitions.len() != initial.len() || initial.is_empty() {
            return Err("Empty or inconsistent device controls".into());
        }
        let mut c = catalog(&definitions, &device);
        if let Some(config) = virtual_config {
            config.validate()?;
        }
        let (virtual_pose, virtual_unavailable) = match virtual_config {
            Some(config) => match VirtualPose::new(&definitions, &initial, config, at) {
                Ok(pose) => {
                    virtual_pose::append_descriptors(&mut c, config);
                    (Some(pose), None)
                }
                Err(reason) => (None, Some(reason)),
            },
            None => (None, None),
        };
        c.validate()?;
        for (d, v) in definitions.iter().zip(&initial) {
            if !valid(d, v) {
                return Err("Invalid initial input".into());
            }
        }
        let count = initial.len();
        Ok(Arc::new(Self {
            virtual_unavailable,
            capabilities: Arc::new(c),
            definitions,
            device,
            clock,
            updates: watch::channel(1).0,
            retired: watch::channel(false).0,
            planned_slot: AtomicU64::new(0),
            schedule_changed: Condvar::new(),
            state: Mutex::new(State {
                virtual_pose,
                connected: true,
                active: vec![true; count],
                values: initial,
                presses: vec![0; count],
                releases: vec![0; count],
                number: 1,
                at,
                last_nominal: at,
                retry: None,
                last_activity: None,
                demands: vec![],
            }),
        }))
    }
    pub(crate) fn virtual_unavailable(&self) -> Option<&str> {
        self.virtual_unavailable.as_deref()
    }
    pub fn now(&self) -> i64 {
        self.clock.now() as i64
    }
    pub fn observe(&self, r: &Request, p: &Arc<Mutex<PublicationState>>) -> protocol::Result<()> {
        let mut s = self.state.lock().unwrap();
        p.lock().unwrap().observe(s.encode(&self.capabilities, r)?);
        s.demands.retain(|d| d.publication.strong_count() > 0);
        s.demands.push(Demand {
            request: r.clone(),
            publication: Arc::downgrade(p),
        });
        self.refresh_plan(&s);
        self.schedule_changed.notify_one();
        Ok(())
    }

    // Schedule changes and registration can move the next slot while the input
    // thread sleeps. The state mutex makes planning and beginning the wait atomic.
    pub fn reschedule(&self) {
        let state = self.state.lock().unwrap();
        self.refresh_plan(&state);
        self.schedule_changed.notify_one();
    }

    fn refresh_plan(&self, state: &State) -> u64 {
        // The nominal grid limits opportunities. A late wake must not move it.
        // Real acquisition spacing is enforced when the snapshot completes.
        let earliest = state.last_nominal.saturating_add(OBSERVATION_PERIOD_NS);
        let after_observation = state.at.saturating_add(1);
        let schedules: Vec<_> = state
            .demands
            .iter()
            .filter_map(|d| d.publication.upgrade())
            .map(|p| {
                let p = p.lock().unwrap();
                (p.timing(), p.next_wake().unwrap_or(0))
            })
            .collect();
        let aligned = schedules
            .iter()
            .min_by_key(|(t, _)| t.interval)
            .and_then(|(grid, _)| {
                if schedules.iter().any(|(t, _)| {
                    t.interval % grid.interval != 0
                        || t.phase % grid.interval != grid.phase % grid.interval
                }) {
                    return None;
                }
                // A reliable update takes effect at its next actual opportunity.
                // Extending the new grid back to the last sample can invent an
                // expired slot, trigger a free-running poll and consume the budget
                // for the first real slot under the device's rate cap.
                let first = schedules.iter().map(|(_, due)| *due).min()?;
                grid.next_at(after_observation.max(first).max(earliest))
                    .filter(|&slot| slot >= earliest && slot - earliest < OBSERVATION_PERIOD_NS)
            });
        self.planned_slot
            .store(aligned.unwrap_or(0), Ordering::Release);
        if let Some((slot, eligible)) = state.retry {
            if aligned == Some(slot) {
                return eligible;
            }
        }
        // Incompatible consumers have no common phase. Preserve the ordinary
        // rate-limited poll in that case.
        aligned.unwrap_or_else(|| state.at.saturating_add(OBSERVATION_PERIOD_NS))
    }

    pub fn wait_for_observation(&self, pump_by: Option<u64>) -> u64 {
        let mut state = self.state.lock().unwrap();
        loop {
            let next = self.refresh_plan(&state);
            let wake = pump_by.map_or(next, |pump| pump.min(next));
            let remaining = wake.saturating_sub(self.clock.now());
            if remaining == 0 {
                return next;
            }
            let (locked, timeout) = self
                .schedule_changed
                .wait_timeout(state, Duration::from_nanos(remaining))
                .unwrap();
            if timeout.timed_out() {
                return next;
            }
            state = locked;
        }
    }

    #[cfg(test)]
    fn next_observation(&self) -> u64 {
        self.refresh_plan(&self.state.lock().unwrap())
    }

    /// The source wakes the sender after installing its promised observation.
    /// Keep a one-millisecond timer fallback if the input thread stalls.
    pub fn publication_deadline(&self, slot: u64) -> u64 {
        if slot != 0 && self.planned_slot.load(Ordering::Acquire) == slot {
            slot.saturating_add(HANDOFF_NS)
        } else {
            slot
        }
    }
    pub fn check(&self, r: &Request) -> protocol::Result<()> {
        self.state
            .lock()
            .unwrap()
            .encode(&self.capabilities, r)
            .map(|_| ())
    }
    pub fn batch(
        &self,
        events: &[(usize, InputValue)],
        values: &[InputValue],
        at: u64,
    ) -> protocol::Result<()> {
        self.install_batch(events, values, at, None).map(|_| ())
    }

    /// The SDL event pump may read retained input between acquisition slots.
    /// Only accepted complete snapshots advance the group or consume its edges.
    pub fn scheduled_batch(
        &self,
        events: &[(usize, InputValue)],
        values: &[InputValue],
        at: u64,
        deadline: u64,
    ) -> protocol::Result<bool> {
        self.install_batch(events, values, at, Some(deadline))
    }

    fn install_batch(
        &self,
        events: &[(usize, InputValue)],
        values: &[InputValue],
        at: u64,
        deadline: Option<u64>,
    ) -> protocol::Result<bool> {
        let mut s = self.state.lock().unwrap();
        if !s.connected {
            return Err("Disconnected epoch cannot reactivate".into());
        }
        if at < s.at {
            return Err("Observation clock moved backwards".into());
        }
        if values.len() != s.values.len() {
            return Err("Control layout changed".into());
        }
        if events
            .iter()
            .any(|(i, v)| *i >= s.values.len() || !valid(&self.definitions[*i], v))
        {
            return Err("Invalid native event".into());
        }
        if let Some(deadline) = deadline {
            let retry = s.retry.take().filter(|&(_, wake)| wake == deadline);
            let nominal = retry.map_or(deadline, |(slot, _)| slot);
            let eligible = s.at.saturating_add(OBSERVATION_PERIOD_NS);
            if at < eligible {
                // Retry a slightly early snapshot while the sender is still
                // waiting for this slot. Otherwise skip it and retain every edge.
                if self.planned_slot.load(Ordering::Acquire) == nominal
                    && eligible <= nominal.saturating_add(HANDOFF_NS)
                {
                    // The first attempt measures this wake plus the snapshot
                    // read. If there is room, start one retry that much ahead
                    // of eligibility. A second early read waits for the hard
                    // limit directly. Only a real, eligible snapshot is used.
                    let compensated = eligible.saturating_sub(at.saturating_sub(deadline));
                    let wake = if retry.is_none() && compensated > at {
                        compensated
                    } else {
                        eligible
                    };
                    s.retry = Some((nominal, wake));
                } else {
                    s.last_nominal = nominal;
                    self.planned_slot.store(0, Ordering::Release);
                    self.updates.send_replace(s.number);
                }
                return Ok(false);
            }
            let elapsed_ticks = at.saturating_sub(nominal) / OBSERVATION_PERIOD_NS;
            s.last_nominal = nominal + elapsed_ticks * OBSERVATION_PERIOD_NS;
        } else {
            s.retry = None;
            s.last_nominal = at;
        }
        if let Some(pose) = &mut s.virtual_pose {
            pose.begin(at, values);
        }
        s.demands.retain(|d| d.publication.strong_count() > 0);
        let publications = s
            .demands
            .iter()
            .filter_map(|d| d.publication.upgrade().map(|p| (d.request.clone(), p)))
            .collect::<Vec<_>>();
        // Lock each publication for the entire poll: transport can never submit old
        // bytes with a revision belonging to an intermediate event/new snapshot.
        let mut guards = publications
            .iter()
            .map(|(_, p)| p.lock().unwrap())
            .collect::<Vec<_>>();
        for (index, value) in events {
            let index = *index;
            if index >= s.values.len() || !valid(&self.definitions[index], value) {
                return Err("Invalid native event".into());
            }
            if s.active[index] && s.values[index] != *value {
                if let (InputValue::Button(old), InputValue::Button(new)) =
                    (&s.values[index], value)
                {
                    if !old && *new {
                        s.presses[index] = s.presses[index].wrapping_add(1);
                    } else if *old && !new {
                        s.releases[index] = s.releases[index].wrapping_add(1);
                    }
                    if let Some(pose) = &mut s.virtual_pose {
                        pose.button_edge(index, *new);
                    }
                }
                s.last_activity = Some(at);
            }
            s.values[index] = value.clone();
            s.active[index] = true;
            for ((r, _), p) in publications.iter().zip(guards.iter_mut()) {
                let a = s.encode(&self.capabilities, r)?;
                p.observe_values(&a.bundles);
            }
        }

        // Reconciliation establishes retained state; missing events never invent edges.
        for (i, v) in values.iter().enumerate() {
            let active = valid(&self.definitions[i], v);
            s.active[i] = active;
            if active {
                s.values[i] = v.clone();
            }
        }
        if let Some(pose) = &mut s.virtual_pose {
            pose.finish(values);
        }
        s.at = at;
        s.number += 1;
        for ((r, _), p) in publications.iter().zip(guards.iter_mut()) {
            p.observe(s.encode(&self.capabilities, r)?);
        }
        self.planned_slot.store(0, Ordering::Release);
        self.updates.send_replace(s.number);
        Ok(true)
    }
    pub fn disconnect(&self, at: u64) {
        let mut s = self.state.lock().unwrap();
        s.connected = false;
        s.active.fill(false);
        if let Some(pose) = &mut s.virtual_pose {
            pose.disconnect();
        }
        s.publish(&self.capabilities, at);
        self.planned_slot.store(0, Ordering::Release);
        self.updates.send_replace(s.number);
    }
    pub fn retire(&self) {
        self.retired.send_replace(true);
    }
    pub fn status(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap();
        serde_json::json!({"device":self.device,"connected":s.connected,"controls":self.definitions.len(),"observed_at_ns":s.at,"last_activity_at_ns":s.last_activity,"retired":*self.retired.borrow(),"virtual_pose":s.virtual_pose.as_ref().map(VirtualPose::status).unwrap_or_else(||serde_json::json!({"supported":false,"requested":self.virtual_unavailable.is_some(),"status":self.virtual_unavailable.as_deref().unwrap_or("Disabled; use --virtual-pose to opt in")}))})
    }
}
fn valid(d: &Definition, v: &InputValue) -> bool {
    match (d.kind, v) {
        (2, InputValue::Button(_)) => true,
        (8, InputValue::Scalar(v)) => (0.0..=1.).contains(v),
        (1, InputValue::Scalar(v)) => v.is_finite(),
        (9, InputValue::Stick(v)) => v.iter().all(|v| (-1.0..=1.).contains(v)),
        _ => false,
    }
}
#[derive(Default)]
pub struct Source {
    pub clock: Arc<Clock>,
    current: Mutex<Option<Arc<Hub>>>,
    report: Mutex<serde_json::Value>,
}
impl Source {
    pub fn current(&self) -> Option<Arc<Hub>> {
        self.current.lock().unwrap().clone()
    }
    pub fn install(&self, hub: Arc<Hub>) {
        if let Some(old) = self.current.lock().unwrap().replace(hub) {
            old.retire();
        }
    }
    pub fn report(&self, value: serde_json::Value) {
        *self.report.lock().unwrap() = value;
    }
    pub fn status(&self) -> serde_json::Value {
        let current = self.current();
        serde_json::json!({"application":"Gamepad Operator","source":current.as_ref().map(|h|h.device.name.clone()).unwrap_or_else(||"No selected gamepad".into()),"pose":current.as_ref().is_some_and(|h|h.capabilities.descriptors.iter().any(|d|d.kind==10)),"prediction":false,"backend":self.report.lock().unwrap().clone(),"selected":current.map(|h|h.status())})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        backend,
        protocol::{SampleBinding, SequenceNumberFormat},
    };
    fn hub(held: bool) -> Arc<Hub> {
        Hub::new(
            backend::synthetic_device(),
            vec![Definition::new(
                "/user/gamepad/input/a/click",
                "South",
                2,
                "test",
            )],
            vec![InputValue::Button(held)],
            Arc::new(Clock::default()),
            10,
        )
        .unwrap()
    }
    fn request(h: &Hub) -> Request {
        Request {
            id: 1,
            group: 0,
            channel: 1,
            interval: 10_000_000,
            phase: 0,
            prediction_offset: 0,
            sequence_number_format: Some(SequenceNumberFormat::U32),
            bundles: vec![
                vec![],
                vec![SampleBinding {
                    descriptor: 2,
                    format: h.capabilities.descriptors[2].formats[0],
                    space: 0,
                }],
            ],
        }
    }
    #[test]
    fn observations_share_live_grids_and_respect_the_device_rate() {
        let h = hub(false);
        let mut r = request(&h);
        r.interval = 16_000_000;
        let first = Arc::new(Mutex::new(PublicationState::new(&r, 0)));
        h.observe(&r, &first).unwrap(); // on-change demand still owns a publication grid
        assert_eq!(h.next_observation(), 16_000_000);
        assert_eq!(
            h.publication_deadline(0),
            0,
            "initial delivery remains immediate"
        );
        assert_eq!(h.publication_deadline(16_000_000), 17_000_000);
        assert_eq!(h.publication_deadline(16_000_001), 16_000_001);
        r.interval *= 2;
        let second = Arc::new(Mutex::new(PublicationState::new(&r, 0)));
        h.observe(&r, &second).unwrap();
        assert_eq!(h.next_observation(), 16_000_000);
        r.phase = 8_000_000;
        second.lock().unwrap().update(r.timing(), 0);
        h.reschedule();
        assert_eq!(h.publication_deadline(16_000_000), 16_000_000);
        assert_eq!(h.next_observation(), 10 + OBSERVATION_PERIOD_NS);
        drop(second);
        assert_eq!(h.next_observation(), 16_000_000);
        h.batch(&[], &[InputValue::Button(false)], 8_000_000)
            .unwrap();
        assert_eq!(h.publication_deadline(16_000_000), 16_000_000);
        assert_eq!(h.next_observation(), 18_000_000);
        r.interval = 100_000_000;
        r.phase = 0;
        first.lock().unwrap().update(r.timing(), 0);
        assert_eq!(h.next_observation(), 18_000_000);
    }

    #[test]
    fn equal_rate_ticks_keep_phase_and_rate_when_wakes_are_late() {
        let h = hub(false);
        let mut r = request(&h);
        r.phase = 10;
        let p = Arc::new(Mutex::new(PublicationState::new(&r, 10)));
        h.observe(&r, &p).unwrap();
        assert!(p.lock().unwrap().opportunity(10));
        let period = OBSERVATION_PERIOD_NS;
        let values = [InputValue::Button(false)];
        for i in 1..=200 {
            let slot = 10 + i * period;
            assert_eq!(h.next_observation(), slot);
            assert!(
                h.scheduled_batch(&[], &values, slot + 70_000, slot)
                    .unwrap()
            );
            assert!(p.lock().unwrap().opportunity(slot + 70_000));
            assert_eq!(h.state.lock().unwrap().at, slot + 70_000);
        }

        let slot = 10 + 201 * period;
        assert_eq!(h.next_observation(), slot);
        let edges = [
            (0, InputValue::Button(true)),
            (0, InputValue::Button(false)),
        ];
        assert!(
            !h.scheduled_batch(&edges, &values, slot + 50_000, slot)
                .unwrap()
        );
        assert_eq!(h.state.lock().unwrap().at, slot - period + 70_000);
        let retry = h.next_observation();
        assert_eq!(retry, slot + 70_000);
        assert!(
            h.scheduled_batch(&edges, &values, retry + 40_000, retry)
                .unwrap()
        );
        assert_eq!(h.state.lock().unwrap().presses[0], 1);
        assert_eq!(h.state.lock().unwrap().releases[0], 1);
        assert!(p.lock().unwrap().opportunity(retry + 40_000));

        let next = slot + period;
        assert_eq!(h.next_observation(), next);
        assert!(
            h.scheduled_batch(&[], &values, next + 2_000_000, next)
                .unwrap()
        );
        assert!(p.lock().unwrap().opportunity(next + 2_000_000));
        let skipped = next + period;
        assert_eq!(h.next_observation(), skipped);
        assert!(
            !h.scheduled_batch(&[], &values, skipped + 60_000, skipped)
                .unwrap()
        );
        assert_eq!(h.publication_deadline(skipped), skipped);
        assert_eq!(h.next_observation(), skipped + period);
        assert_eq!(h.state.lock().unwrap().at, next + 2_000_000);
    }

    #[test]
    fn early_read_retries_once_with_measured_cost_and_respects_the_absolute_limit() {
        let h = hub(false);
        let mut r = request(&h);
        r.phase = 10;
        let p = Arc::new(Mutex::new(PublicationState::new(&r, 10)));
        h.observe(&r, &p).unwrap();
        assert!(p.lock().unwrap().opportunity(10));
        let values = [InputValue::Button(false)];
        let first = h.next_observation();
        assert!(
            h.scheduled_batch(&[], &values, first + 250_000, first)
                .unwrap()
        );
        assert!(p.lock().unwrap().opportunity(first + 250_000));
        let next = h.next_observation();
        assert!(
            !h.scheduled_batch(&[], &values, next + 70_000, next)
                .unwrap()
        );
        let retry = h.next_observation();
        assert_eq!(retry, next + 180_000);
        assert!(
            !h.scheduled_batch(&[], &values, retry + 35_000, retry)
                .unwrap()
        );
        let eligible = h.next_observation();
        assert_eq!(eligible, next + 250_000);
        assert!(
            h.scheduled_batch(&[], &values, eligible + 40_000, eligible)
                .unwrap()
        );
        assert!(p.lock().unwrap().opportunity(eligible + 40_000));
        assert_eq!(h.next_observation(), next + OBSERVATION_PERIOD_NS);
    }

    #[test]
    fn a_retimed_grid_starts_at_the_first_actual_publication_slot() {
        let h = hub(false);
        let mut r = request(&h);
        r.interval = 16_000_000;
        let p = Arc::new(Mutex::new(PublicationState::new(&r, 0)));
        h.observe(&r, &p).unwrap();
        assert!(p.lock().unwrap().opportunity(10));
        h.batch(&[], &[InputValue::Button(false)], 16_060_000)
            .unwrap();
        r.phase = 600_000;
        p.lock().unwrap().update(r.timing(), 20_000_000);
        h.reschedule();
        assert_eq!(h.next_observation(), 32_600_000);
        assert!(h.publication_deadline(32_600_000) > 32_600_000);
    }

    #[test]
    fn on_change_slot_waits_for_the_promised_observation_then_releases_on_ack() {
        let h = hub(false);
        let mut r = request(&h);
        r.interval = 16_000_000;
        let p = Arc::new(Mutex::new(PublicationState::new(&r, 10)));
        h.observe(&r, &p).unwrap();
        {
            let mut publication = p.lock().unwrap();
            assert!(publication.opportunity(10));
            let initial = publication.candidate().unwrap();
            publication.submitted(initial);
            publication.acknowledge(0);
            assert!(publication.candidate().is_none());
        }
        let slot = h.next_observation();
        assert_eq!(slot, p.lock().unwrap().next_wake().unwrap());
        assert!(h.publication_deadline(slot) > slot); // early sender wake
        let acquired = slot + 64_000;
        h.batch(
            &[(0, InputValue::Button(true))],
            &[InputValue::Button(true)],
            acquired,
        )
        .unwrap();
        assert_eq!(h.publication_deadline(slot), slot);
        let mut publication = p.lock().unwrap();
        assert!(publication.opportunity(acquired));
        let changed = publication.candidate().unwrap();
        assert_eq!(
            u64::from_le_bytes(changed.body[4..12].try_into().unwrap()),
            acquired
        );
        publication.submitted(changed);
        publication.acknowledge(1);
        assert!(publication.candidate().is_none());
    }

    #[test]
    fn initial_held_idle_native_edges_and_disconnect_are_distinct() {
        let h = hub(true);
        {
            let s = h.state.lock().unwrap();
            assert_eq!(s.presses, [0]);
            assert_eq!(s.releases, [0]);
        }
        h.batch(&[], &[InputValue::Button(true)], 2_000_000_000)
            .unwrap();
        {
            let s = h.state.lock().unwrap();
            assert!(s.active[0]);
            assert_eq!(s.at, 2_000_000_000);
            assert_eq!(s.presses, [0]);
            assert_eq!(s.last_activity, None);
        }
        h.batch(
            &[
                (0, InputValue::Button(false)),
                (0, InputValue::Button(true)),
                (0, InputValue::Button(true)),
            ],
            &[InputValue::Button(true)],
            3_000_000_000,
        )
        .unwrap();
        h.disconnect(3_000_000_001);
        let s = h.state.lock().unwrap();
        assert!(!s.connected);
        assert_eq!(s.active, [false]);
        assert_eq!(s.presses, [1]);
        assert_eq!(s.releases, [1]);
        assert!(matches!(s.wire_values()[2], Value::Bit(false)));
        assert_eq!(s.at, 3_000_000_001);
        drop(s);
        assert!(
            h.batch(&[], &[InputValue::Button(true)], 4_000_000_000)
                .is_err()
        );
    }
    #[test]
    fn intra_poll_aba_supersedes_ack_without_fabricating_acquisitions() {
        let h = hub(false);
        let r = request(&h);
        let p = Arc::new(Mutex::new(PublicationState::new(&r, 10)));
        h.observe(&r, &p).unwrap();
        let sent = p.lock().unwrap().candidate().unwrap();
        p.lock().unwrap().submitted(sent);
        h.batch(
            &[
                (0, InputValue::Button(true)),
                (0, InputValue::Button(false)),
            ],
            &[InputValue::Button(false)],
            20,
        )
        .unwrap();
        p.lock().unwrap().acknowledge(0);
        let candidate = p.lock().unwrap().candidate().unwrap();
        assert_eq!(
            u64::from_le_bytes(candidate.body[4..12].try_into().unwrap()),
            20
        );
        p.lock().unwrap().submitted(candidate);
        p.lock().unwrap().acknowledge(1);
        assert!(p.lock().unwrap().candidate().is_none());
        assert_eq!(h.state.lock().unwrap().number, 2); // One poll, not two physical samples.
    }
    #[test]
    fn invalid_snapshot_activity_and_counter_widths_are_truthful() {
        let h = hub(false);
        h.state.lock().unwrap().presses[0] = u64::MAX;
        h.batch(
            &[(0, InputValue::Button(true))],
            &[InputValue::Button(true)],
            20,
        )
        .unwrap();
        assert_eq!(h.state.lock().unwrap().presses, [0]);
        h.batch(&[], &[InputValue::Scalar(f64::NAN)], 30).unwrap();
        assert_eq!(h.state.lock().unwrap().active, [false]);
        h.batch(
            &[(0, InputValue::Button(false))],
            &[InputValue::Button(false)],
            40,
        )
        .unwrap();
        assert_eq!(h.state.lock().unwrap().releases, [0]);
        assert!(h.batch(&[], &[], 41).is_err());
        assert!(h.batch(&[], &[InputValue::Button(false)], 39).is_err());
    }
    #[test]
    fn new_epoch_retires_old_peers_and_rebuilds_actual_capabilities() {
        let source = Source::default();
        let a = hub(false);
        source.install(a.clone());
        a.batch(
            &[(0, InputValue::Button(true))],
            &[InputValue::Button(true)],
            20,
        )
        .unwrap();
        a.disconnect(30);
        let b = Hub::new(
            backend::synthetic_device(),
            vec![Definition::new(
                "/gamepad/raw/axis/0",
                "Raw axis 0",
                1,
                "unknown layout",
            )],
            vec![InputValue::Scalar(-0.2)],
            source.clock.clone(),
            40,
        )
        .unwrap();
        source.install(b.clone());
        assert!(*a.retired.borrow());
        assert!(!*b.retired.borrow());
        assert!(
            !b.capabilities
                .descriptors
                .iter()
                .any(|d| d.kind == 2 || d.id.contains("/a/click"))
        );
    }
    #[test]
    fn catalog_references_and_formats_follow_current_protocol() {
        let h = Hub::new(
            backend::synthetic_device(),
            backend::synthetic_definitions(),
            backend::synthetic_values(0),
            Arc::new(Clock::default()),
            1,
        )
        .unwrap();
        h.capabilities.validate().unwrap();
        assert!(!h.capabilities.descriptors.iter().any(|d| d.kind == 10));
        for (i, d) in h.capabilities.descriptors.iter().enumerate() {
            if d.kind == 2 {
                assert_eq!(
                    h.capabilities.descriptors[d.press_count_sample.unwrap() as usize].kind,
                    3
                );
                assert_eq!(
                    h.capabilities.descriptors[d.release_count_sample.unwrap() as usize].kind,
                    4
                );
                assert_eq!(
                    h.capabilities.descriptors[i + 1].id,
                    format!("{}/active", d.id)
                );
            }
        }
    }
    fn virtual_hub(initial: Vec<InputValue>, at: u64) -> Arc<Hub> {
        Hub::with_virtual(
            backend::synthetic_device(),
            backend::synthetic_definitions(),
            initial,
            Arc::new(Clock::default()),
            at,
            Some(virtual_pose::Config::default()),
        )
        .unwrap()
    }
    #[test]
    fn virtual_script_preserves_every_raw_value_and_counter_and_encodes_truthful_pose() {
        let mut previous = backend::synthetic_virtual_values(0);
        let virtual_hub = virtual_hub(previous.clone(), 0);
        let raw = Hub::new(
            backend::synthetic_device(),
            backend::synthetic_definitions(),
            previous.clone(),
            Arc::new(Clock::default()),
            0,
        )
        .unwrap();
        for (v, r) in virtual_hub
            .capabilities
            .descriptors
            .iter()
            .zip(&raw.capabilities.descriptors)
        {
            let mut expected = r.clone();
            if matches!(
                r.id.as_str(),
                "/user/gamepad/input/trigger_left/value"
                    | "/user/gamepad/input/trigger_right/value"
            ) {
                assert!(v.description.starts_with(&r.description) && v.name.starts_with(&r.name));
                expected.name = v.name.clone();
                expected.description = v.description.clone();
            }
            assert_eq!(v, &expected);
        }
        let request = Request {
            bundles: vec![
                raw.capabilities
                    .descriptors
                    .iter()
                    .enumerate()
                    .map(|(i, d)| SampleBinding {
                        descriptor: i as u32,
                        format: d.formats[0],
                        space: 0,
                    })
                    .collect(),
            ],
            ..request(&raw)
        };
        let all = Request {
            bundles: vec![
                virtual_hub
                    .capabilities
                    .descriptors
                    .iter()
                    .enumerate()
                    .map(|(i, d)| SampleBinding {
                        descriptor: i as u32,
                        format: d.formats[0],
                        space: d.spaces.first().copied().unwrap_or(0),
                    })
                    .collect(),
            ],
            ..request.clone()
        };
        for tick in 1..1000 {
            let values = backend::synthetic_virtual_values(tick);
            let events = values
                .iter()
                .enumerate()
                .filter(|(i, v)| previous[*i] != **v)
                .map(|(i, v)| (i, v.clone()))
                .collect::<Vec<_>>();
            for h in [&raw, &virtual_hub] {
                h.batch(&events, &values, tick * 10_000_000).unwrap();
            }
            let a = raw
                .state
                .lock()
                .unwrap()
                .encode(&raw.capabilities, &request)
                .unwrap();
            let state = virtual_hub.state.lock().unwrap();
            let b = state.encode(&virtual_hub.capabilities, &request).unwrap();
            assert_eq!(a.bundles, b.bundles);
            assert_eq!(a.acquired_at, b.acquired_at);
            let full = state.encode(&virtual_hub.capabilities, &all).unwrap();
            assert_eq!(full.predicted_for, None);
            let pose = state.virtual_pose.as_ref().unwrap().wire_values();
            assert!(matches!(pose[1], Value::Bit(true)));
            assert!(matches!(pose[2], Value::Bit(true)));
            assert!(matches!(pose[3], Value::Bit(false)));
            assert!(matches!(pose[4], Value::Bit(false)));
            if let Value::Numbers(values) = &pose[0] {
                assert!(protocol::valid_numbers(10, 11, values));
            } else {
                panic!("Missing virtual pose")
            }
            if tick == 800 {
                assert!(matches!(pose[5], Value::Bit(true)));
            }
            if tick >= 855 {
                assert!(matches!(pose[5], Value::Bit(false)));
                if let Value::Numbers(v) = &pose[0] {
                    assert_eq!(v, &[0., 0., 0., 0., 0., 0., 1.]);
                }
            }
            previous = values;
        }
        let pose_index = raw.capabilities.descriptors.len();
        let mut invalid = all;
        invalid.bundles[0][pose_index].space = 2;
        assert!(virtual_hub.capabilities.validate_request(&invalid).is_err());
    }
    #[test]
    fn virtual_disconnect_epoch_and_initial_held_toggle_never_resume_motion() {
        let held = backend::synthetic_virtual_values(800);
        let h = virtual_hub(held.clone(), 0);
        h.batch(&[], &held, 10_000_000).unwrap();
        assert_eq!(h.status()["virtual_pose"]["enabled"], false);
        h.disconnect(20_000_000);
        let s = h.state.lock().unwrap();
        let values = s.virtual_pose.as_ref().unwrap().wire_values();
        assert!(matches!(values[1], Value::Bit(false)));
        assert!(matches!(values[2], Value::Bit(false)));
        assert_eq!(s.at, 20_000_000);
        drop(s);
        let fresh = virtual_hub(held.clone(), 30_000_000);
        fresh.batch(&[], &held, 40_000_000).unwrap();
        assert_eq!(fresh.status()["virtual_pose"]["enabled"], false);
        let neutral = backend::synthetic_virtual_values(0);
        fresh
            .batch(&[(5, InputValue::Button(false))], &neutral, 50_000_000)
            .unwrap();
        fresh
            .batch(&[(5, InputValue::Button(true))], &held, 60_000_000)
            .unwrap();
        assert_eq!(fresh.status()["virtual_pose"]["enabled"], true);
    }
    #[test]
    fn unsupported_virtual_mapping_keeps_raw_catalog_and_diagnostic() {
        let h = Hub::with_virtual(
            backend::synthetic_device(),
            vec![Definition::new("/gamepad/raw/axis/0", "raw", 1, "unknown")],
            vec![InputValue::Scalar(0.)],
            Arc::new(Clock::default()),
            0,
            Some(virtual_pose::Config::default()),
        )
        .unwrap();
        assert!(!h.capabilities.descriptors.iter().any(|d| d.kind == 10));
        assert_eq!(h.status()["virtual_pose"]["requested"], true);
        assert!(
            h.status()["virtual_pose"]["status"]
                .as_str()
                .unwrap()
                .contains("missing mapped")
        );
    }
}
