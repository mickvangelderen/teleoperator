//! Version 1 wire records and connection-local subscription state.
use std::collections::{BTreeMap, HashSet};

pub const MAX_CONTROL: usize = 1_048_576;
pub const MAX_PACKET: usize = 16_384;
pub const MAX_SUBSCRIPTIONS: usize = 16;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Descriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: u8,
    pub formats: Vec<u8>,
    pub group: u32,
    pub spaces: Vec<u8>,
    pub press_count_sample: Option<u32>,
    pub release_count_sample: Option<u32>,
    pub touch_count_sample: Option<u32>,
    pub untouch_count_sample: Option<u32>,
    pub position_valid_sample: Option<u32>,
    pub orientation_valid_sample: Option<u32>,
    pub position_tracked_sample: Option<u32>,
    pub orientation_tracked_sample: Option<u32>,
    pub confidence_sample: Option<u32>,
    pub revision_of: Option<u32>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Joint {
    pub parent: u32,
    pub pose_sample: u32,
    pub rest_pose_sample: u32,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Capabilities {
    pub groups: Vec<f32>,
    pub descriptors: Vec<Descriptor>,
    pub skeletons: Vec<Vec<Joint>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Selection {
    pub descriptor: u32,
    pub format: u8,
    pub space: u8,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Schedule {
    Periodic {
        interval: u64,
        phase: u64,
        consumption_delay: u64,
    },
    OnChange,
}
impl Schedule {
    pub fn validate(&self, max_rate: f32, now: u64) -> Result<()> {
        if let Self::Periodic {
            interval,
            phase,
            consumption_delay,
        } = *self
        {
            if interval == 0
                || [interval, phase, consumption_delay].contains(&u64::MAX)
                || (interval as f64) < (1e9 / max_rate as f64).ceil()
            {
                return Err("Unsupported publication schedule".into());
            }
            self.next_at(now)
                .and_then(|time| time.checked_add(consumption_delay))
                .filter(|target| *target < u64::MAX)
                .ok_or("Schedule time overflow")?;
        }
        Ok(())
    }
    pub fn next_at(&self, now: u64) -> Option<u64> {
        match *self {
            Self::Periodic {
                interval, phase, ..
            } if interval > 0 => {
                let offset = (phase as u128 + interval as u128 - now as u128 % interval as u128)
                    % interval as u128;
                u64::try_from(now as u128 + offset)
                    .ok()
                    .filter(|t| *t < u64::MAX)
            }
            _ => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: u32,
    pub group: u32,
    pub delivery: u8,
    pub schedule: Schedule,
    pub samples: Vec<Selection>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Publication(Vec<u8>),
    Offer(Vec<u16>),
    Selection(u16),
    Capabilities(Capabilities),
    Subscribe(Request),
    SubscribeBody(Vec<u8>),
    Accepted { id: u32 },
    Rejected { id: u32, reason: Option<String> },
    Unsubscribe { id: u32 },
    Ended { id: u32, reason: String },
    UpdateSchedule { id: u32, schedule: Schedule },
}

pub fn compatible(kind: u8, format: u8) -> bool {
    match kind {
        1 => (1..=15).contains(&format),
        2 | 5 | 12..=15 => format == 1,
        3 | 4 | 6 | 7 | 11 => (2..=5).contains(&format),
        8 | 16 => matches!(format, 10..=13),
        9 => matches!(format, 10 | 11 | 14 | 15),
        10 => matches!(format, 10 | 11),
        _ => false,
    }
}
pub fn components(kind: u8) -> usize {
    match kind {
        9 => 2,
        10 => 7,
        _ => 1,
    }
}
pub fn width(format: u8) -> usize {
    match format {
        1 => 0,
        2 | 6 | 12 | 14 => 1,
        3 | 7 | 13 | 15 => 2,
        4 | 8 | 10 => 4,
        5 | 9 | 11 => 8,
        _ => 0,
    }
}
impl Capabilities {
    pub fn validate(&self) -> Result<()> {
        if self.groups.iter().any(|r| !r.is_finite() || *r <= 0.) {
            return Err("Invalid group rate".into());
        }
        let mut ids = HashSet::new();
        for d in &self.descriptors {
            if d.id.is_empty()
                || !ids.insert(&d.id)
                || d.group as usize >= self.groups.len()
                || d.formats.is_empty()
                || d.formats.iter().any(|f| !compatible(d.kind, *f))
                || d.formats.iter().collect::<HashSet<_>>().len() != d.formats.len()
                || (d.kind == 10
                    && (d.spaces.is_empty()
                        || d.spaces.iter().any(|s| !(1..=6).contains(s))
                        || d.spaces.iter().collect::<HashSet<_>>().len() != d.spaces.len()))
                || (d.kind != 10 && !d.spaces.is_empty())
            {
                return Err("Invalid descriptor".into());
            }
            for (index, kind, owner) in [
                (d.press_count_sample, 3, 2),
                (d.release_count_sample, 4, 2),
                (d.touch_count_sample, 6, 5),
                (d.untouch_count_sample, 7, 5),
                (d.position_valid_sample, 12, 10),
                (d.orientation_valid_sample, 13, 10),
                (d.position_tracked_sample, 14, 10),
                (d.orientation_tracked_sample, 15, 10),
                (d.confidence_sample, 16, 10),
            ] {
                if let Some(index) = index
                    && (d.kind != owner
                        || self
                            .descriptors
                            .get(index as usize)
                            .is_none_or(|target| target.kind != kind))
                {
                    return Err("Invalid descriptor reference".into());
                }
            }
            if (d.kind == 11
                && d.revision_of
                    .is_none_or(|g| g as usize >= self.groups.len()))
                || (d.kind != 11 && d.revision_of.is_some())
            {
                return Err("Invalid revision group".into());
            }
        }
        for skeleton in &self.skeletons {
            if skeleton.is_empty() {
                return Err("Empty skeleton".into());
            }
            for joint in skeleton {
                if joint.parent as usize >= skeleton.len()
                    || [joint.pose_sample, joint.rest_pose_sample].iter().any(|i| {
                        self.descriptors
                            .get(*i as usize)
                            .is_none_or(|d| d.kind != 10)
                    })
                {
                    return Err("Invalid skeleton reference".into());
                }
            }
        }
        Ok(())
    }
    pub fn validate_request(&self, r: &Request) -> Result<usize> {
        if !matches!(r.delivery, 1 | 2) {
            return Err("Unsupported delivery mode".into());
        }
        let max = self.groups.get(r.group as usize).ok_or("Unknown group")?;
        r.schedule.validate(*max, 0)?;
        if r.samples.is_empty() {
            return Err("Select at least one sample".into());
        }
        let mut seen = HashSet::new();
        let mut size = 20 + r.samples.len().div_ceil(8);
        let mut bits: usize = 0;
        for s in &r.samples {
            let d = self
                .descriptors
                .get(s.descriptor as usize)
                .ok_or("Unknown descriptor")?;
            if d.group != r.group || !seen.insert(s.descriptor) {
                return Err("Wrong group or duplicate sample".into());
            }
            if !d.formats.contains(&s.format) || !compatible(d.kind, s.format) {
                return Err("Unsupported sample format".into());
            }
            if if d.kind == 10 {
                !d.spaces.contains(&s.space)
            } else {
                s.space != 0
            } {
                return Err("Unsupported reference space".into());
            }
            if s.format == 1 {
                bits += 1;
            } else {
                size += components(d.kind) * width(s.format);
            }
        }
        if size + bits.div_ceil(8) + 1
            > if r.delivery == 1 {
                MAX_PACKET
            } else {
                MAX_CONTROL
            }
        {
            return Err("Tracking packet exceeds transport limit".into());
        }
        Ok(size + bits.div_ceil(8))
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or("Length overflow")?;
        let value = self
            .bytes
            .get(self.at..end)
            .ok_or("Truncated control record")?;
        self.at = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn schedule(&mut self) -> Result<Schedule> {
        match self.u8()? {
            1 => Ok(Schedule::Periodic {
                interval: self.u64()?,
                phase: self.u64()?,
                consumption_delay: self.u64()?,
            }),
            2 => Ok(Schedule::OnChange),
            _ => Err("Invalid publication schedule tag".into()),
        }
    }
    fn count(&mut self, minimum: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        if n > (self.bytes.len() - self.at) / minimum {
            return Err("Impossible list count".into());
        }
        Ok(n)
    }
}
fn decode_client(body: &[u8]) -> Result<Message> {
    let mut r = Reader { bytes: body, at: 0 };
    let message = match r.u8()? {
        1 => {
            let n = r.count(2)?;
            let mut versions = Vec::with_capacity(n);
            for _ in 0..n {
                versions.push(r.u16()?);
            }
            if versions.is_empty()
                || versions.contains(&0)
                || versions.iter().collect::<HashSet<_>>().len() != n
            {
                return Err("Invalid version offer".into());
            }
            Message::Offer(versions)
        }
        4 => {
            let body = r.take(body.len() - 1)?.to_vec();
            Message::SubscribeBody(body)
        }
        7 => Message::Unsubscribe { id: r.u32()? },
        12 => Message::UpdateSchedule {
            id: r.u32()?,
            schedule: r.schedule()?,
        },
        _ => return Err("Invalid client message tag or direction".into()),
    };
    if r.at != body.len() {
        return Err("Trailing control bytes".into());
    }
    Ok(message)
}
fn decode_subscription(body: &[u8], capabilities: &Capabilities) -> Result<Request> {
    let mut r = Reader { bytes: body, at: 0 };
    let id = r.u32()?;
    let group = r.u32()?;
    let n = r.count(5)?;
    let mut samples = Vec::with_capacity(n);
    for _ in 0..n {
        let descriptor = r.u32()?;
        let kind = capabilities
            .descriptors
            .get(descriptor as usize)
            .ok_or("Unknown descriptor in selection layout")?
            .kind;
        samples.push(Selection {
            descriptor,
            format: r.u8()?,
            space: if kind == 10 { r.u8()? } else { 0 },
        });
    }
    let delivery = r.u8()?;
    let schedule = r.schedule()?;
    if r.at != body.len() {
        return Err("Trailing subscription bytes".into());
    }
    Ok(Request {
        id,
        group,
        samples,
        delivery,
        schedule,
    })
}
#[derive(Default)]
pub struct ControlDecoder {
    pending: Vec<u8>,
}
impl ControlDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Message>> {
        if self.pending.len().saturating_add(bytes.len()) > MAX_CONTROL * 2 {
            return Err("Control buffer limit".into());
        }
        self.pending.extend_from_slice(bytes);
        let mut messages = Vec::new();
        let mut at = 0;
        while self.pending.len() - at >= 4 {
            let n = u32::from_le_bytes(self.pending[at..at + 4].try_into().unwrap()) as usize;
            if n == 0 || n > MAX_CONTROL {
                return Err("Control record length limit".into());
            }
            if self.pending.len() - at < n + 4 {
                break;
            }
            messages.push(decode_client(&self.pending[at + 4..at + 4 + n])?);
            at += 4 + n;
            if messages.len() > 1024 {
                return Err("Too many control records".into());
            }
        }
        self.pending.drain(..at);
        Ok(messages)
    }
}
fn u32_bytes(b: &mut Vec<u8>, n: u32) {
    b.extend(n.to_le_bytes());
}
fn string(b: &mut Vec<u8>, s: &str) {
    u32_bytes(b, s.len() as u32);
    b.extend(s.as_bytes());
}
fn schedule_bytes(b: &mut Vec<u8>, schedule: &Schedule) {
    match schedule {
        Schedule::OnChange => b.push(2),
        Schedule::Periodic {
            interval,
            phase,
            consumption_delay,
        } => {
            b.push(1);
            for value in [interval, phase, consumption_delay] {
                b.extend(value.to_le_bytes());
            }
        }
    }
}
pub fn clock_response(id: u32, received: u64, sent: u64) -> Vec<u8> {
    let mut b = vec![11];
    b.extend(id.to_le_bytes());
    b.extend(received.to_le_bytes());
    b.extend(sent.to_le_bytes());
    b
}
pub fn encode(message: &Message) -> Vec<u8> {
    let mut b = vec![0; 4];
    match message {
        Message::Offer(versions) => {
            b.push(1);
            u32_bytes(&mut b, versions.len() as u32);
            for v in versions {
                b.extend(v.to_le_bytes());
            }
        }
        Message::Selection(v) => {
            b.push(2);
            b.extend(v.to_le_bytes());
        }
        Message::Capabilities(c) => {
            b.push(3);
            u32_bytes(&mut b, c.groups.len() as u32);
            for g in &c.groups {
                b.extend(g.to_le_bytes());
            }
            u32_bytes(&mut b, c.descriptors.len() as u32);
            for d in &c.descriptors {
                string(&mut b, &d.id);
                string(&mut b, &d.name);
                string(&mut b, &d.description);
                b.push(d.kind);
                u32_bytes(&mut b, d.formats.len() as u32);
                b.extend(&d.formats);
                u32_bytes(&mut b, d.group);
                if d.kind == 10 {
                    u32_bytes(&mut b, d.spaces.len() as u32);
                    b.extend(&d.spaces);
                }
                let references: &[Option<u32>] = match d.kind {
                    2 => &[d.press_count_sample, d.release_count_sample],
                    5 => &[d.touch_count_sample, d.untouch_count_sample],
                    10 => &[
                        d.position_valid_sample,
                        d.orientation_valid_sample,
                        d.position_tracked_sample,
                        d.orientation_tracked_sample,
                        d.confidence_sample,
                    ],
                    11 => &[d.revision_of],
                    _ => &[],
                };
                for index in references {
                    u32_bytes(&mut b, index.unwrap_or(u32::MAX));
                }
            }
            u32_bytes(&mut b, c.skeletons.len() as u32);
            for skeleton in &c.skeletons {
                u32_bytes(&mut b, skeleton.len() as u32);
                for joint in skeleton {
                    for index in [joint.parent, joint.pose_sample, joint.rest_pose_sample] {
                        u32_bytes(&mut b, index);
                    }
                }
            }
        }
        Message::Subscribe(r) => {
            b.push(4);
            u32_bytes(&mut b, r.id);
            u32_bytes(&mut b, r.group);
            u32_bytes(&mut b, r.samples.len() as u32);
            for s in &r.samples {
                u32_bytes(&mut b, s.descriptor);
                b.push(s.format);
                if s.space != 0 {
                    b.push(s.space);
                }
            }
            b.push(r.delivery);
            schedule_bytes(&mut b, &r.schedule);
        }
        Message::SubscribeBody(body) => {
            b.push(4);
            b.extend(body);
        }
        Message::Accepted { id } | Message::Unsubscribe { id } => {
            b.push(if matches!(message, Message::Accepted { .. }) {
                5
            } else {
                7
            });
            u32_bytes(&mut b, *id);
        }
        Message::Rejected { id, reason } => {
            b.push(6);
            u32_bytes(&mut b, *id);
            b.push(u8::from(reason.is_some()));
            if let Some(reason) = reason {
                string(&mut b, reason);
            }
        }
        Message::UpdateSchedule { id, schedule } => {
            b.push(12);
            u32_bytes(&mut b, *id);
            schedule_bytes(&mut b, schedule);
        }
        Message::Publication(body) => {
            b.push(9);
            b.extend(body);
        }
        Message::Ended { id, reason } => {
            b.push(8);
            u32_bytes(&mut b, *id);
            string(&mut b, reason);
        }
    }
    let length = (b.len() - 4) as u32;
    b[..4].copy_from_slice(&length.to_le_bytes());
    b
}

#[derive(Clone, Debug)]
pub struct Subscription {
    pub request: Request,
    pub next_due: Option<u64>,
    last_publication: Option<Vec<u8>>,
}
impl Subscription {
    pub fn timestamp(&self, acquired: i64, now: i64) -> Option<u64> {
        if acquired > now {
            return None;
        }
        u64::try_from(acquired).ok().filter(|t| *t < u64::MAX)
    }
    pub fn due(&self, now: u64) -> bool {
        self.last_publication.is_none() || self.next_due.is_none_or(|t| now >= t)
    }
    pub fn advance(&mut self, now: u64) -> Result<()> {
        if matches!(self.request.schedule, Schedule::Periodic { .. }) {
            self.next_due = now
                .checked_add(1)
                .and_then(|t| self.request.schedule.next_at(t));
            if self.next_due.is_none() {
                return Err("Publication schedule exhausted".into());
            }
        }
        Ok(())
    }
    pub fn should_publish(&self, body: &[u8]) -> bool {
        !matches!(self.request.schedule, Schedule::OnChange)
            || self
                .last_publication
                .as_ref()
                .is_none_or(|previous| previous != &body[20..])
    }
    pub fn published(&mut self, body: &[u8]) {
        // Only selected encoded values and availability drive OnChange, including after an update.
        self.last_publication = Some(body[20..].to_vec());
    }
    fn update(&mut self, schedule: Schedule, now: u64) {
        self.next_due = schedule.next_at(now);
        self.request.schedule = schedule;
    }
}

pub struct Session {
    pub capabilities: Capabilities,
    pub negotiated: bool,
    pub packet_limit: usize,
    pub active: BTreeMap<u32, Subscription>,
}
impl Session {
    pub fn new(capabilities: Capabilities) -> Self {
        Self {
            capabilities,
            negotiated: false,
            packet_limit: MAX_PACKET,
            active: BTreeMap::new(),
        }
    }
    pub fn handle(&mut self, message: Message, now: i64) -> Result<Vec<Message>> {
        if !self.negotiated {
            if let Message::Offer(v) = message {
                if !v.contains(&1) {
                    return Ok(vec![Message::Selection(0)]);
                }
                self.capabilities.validate()?;
                self.negotiated = true;
                return Ok(vec![
                    Message::Selection(1),
                    Message::Capabilities(self.capabilities.clone()),
                ]);
            }
            return Err("Version offer must be first".into());
        }
        let message = if let Message::SubscribeBody(body) = message {
            Message::Subscribe(decode_subscription(&body, &self.capabilities)?)
        } else {
            message
        };
        match message {
            Message::Subscribe(request) => {
                let id = request.id;
                let validation = self
                    .capabilities
                    .validate_request(&request)
                    .and_then(|size| {
                        request.schedule.validate(
                            self.capabilities.groups[request.group as usize],
                            now as u64,
                        )?;
                        if request.delivery == 1 && size + 1 > self.packet_limit {
                            return Err("Tracking packet exceeds negotiated transport limit".into());
                        }
                        if self.active.len() >= MAX_SUBSCRIPTIONS && !self.active.contains_key(&id)
                        {
                            return Err("Subscription limit".into());
                        }
                        Ok(())
                    });
                if let Err(reason) = validation {
                    return Ok(vec![Message::Rejected {
                        id,
                        reason: Some(reason),
                    }]);
                }
                let mut replies = self.end(id, "Replaced by a new subscription");
                self.active.insert(
                    id,
                    Subscription {
                        next_due: request.schedule.next_at(now as u64),
                        request,
                        last_publication: None,
                    },
                );
                replies.push(Message::Accepted { id });
                Ok(replies)
            }
            Message::Unsubscribe { id } => {
                self.active.remove(&id);
                Ok(vec![Message::Ended {
                    id,
                    reason: "Unsubscribed".into(),
                }])
            }
            Message::UpdateSchedule { id, schedule } => {
                // Validate even for an ended id; a termination can race a well-formed update.
                schedule.validate(
                    self.active.get(&id).map_or(f32::MAX, |s| {
                        self.capabilities.groups[s.request.group as usize]
                    }),
                    now as u64,
                )?;
                if let Some(sub) = self.active.get_mut(&id) {
                    sub.update(schedule, now as u64);
                }
                Ok(vec![])
            }
            _ => Err("Message in invalid session phase".into()),
        }
    }
    pub fn end(&mut self, id: u32, reason: &str) -> Vec<Message> {
        self.active
            .remove(&id)
            .map(|_| {
                vec![Message::Ended {
                    id,
                    reason: reason.into(),
                }]
            })
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug)]
pub enum Value {
    Bit(bool),
    Unsigned(u64),
    Signed(i64),
    Numbers(Vec<f64>),
}
pub fn valid_numbers(kind: u8, format: u8, values: &[f64]) -> bool {
    if values.len() != components(kind) {
        return false;
    }
    if kind == 1 {
        return true;
    }
    if !values.iter().all(|x| x.is_finite()) {
        return false;
    }
    match kind {
        8 | 16 => (0.0..=1.0).contains(&values[0]),
        9 => values.iter().all(|x| (-1.0..=1.0).contains(x)),
        10 => {
            (values[3..].iter().map(|x| x * x).sum::<f64>() - 1.).abs()
                <= if format == 10 { 1e-5 } else { 1e-12 }
        }
        _ => false,
    }
}
fn encode_value(value: &Value, kind: u8, format: u8) -> Option<Vec<u8>> {
    if !compatible(kind, format) {
        return None;
    }
    let mut b = Vec::new();
    match (value, format) {
        (Value::Bit(v), 1) => b.push(u8::from(*v)),
        (Value::Unsigned(v), 2..=5) => {
            let bits = width(format) * 8;
            if kind == 1 && bits < 64 && *v >= 1u64 << bits {
                return None;
            }
            b.extend(&v.to_le_bytes()[..width(format)]);
        }
        (Value::Signed(v), 6..=9) => {
            let bits = width(format) * 8;
            if bits < 64 && (*v < -(1i64 << (bits - 1)) || *v >= 1i64 << (bits - 1)) {
                return None;
            }
            b.extend(&v.to_le_bytes()[..width(format)]);
        }
        (Value::Numbers(values), 10..=15) => {
            let converted: Vec<_> = values
                .iter()
                .map(|v| if format == 10 { (*v as f32) as f64 } else { *v })
                .collect();
            if !valid_numbers(kind, format, values) || !valid_numbers(kind, format, &converted) {
                return None;
            }
            for v in converted {
                match format {
                    10 => b.extend((v as f32).to_le_bytes()),
                    11 => b.extend(v.to_le_bytes()),
                    12 | 13 if v.is_finite() && (0.0..=1.0).contains(&v) => {
                        let n =
                            (v * if format == 12 { 255. } else { 65535. }).round_ties_even() as u16;
                        b.extend(&n.to_le_bytes()[..width(format)]);
                    }
                    14 | 15 if v.is_finite() && (-1.0..=1.0).contains(&v) => {
                        let n =
                            (v * if format == 14 { 127. } else { 32767. }).round_ties_even() as i16;
                        b.extend(&n.to_le_bytes()[..width(format)]);
                    }
                    _ => return None,
                }
            }
        }
        _ => return None,
    }
    Some(b)
}
pub fn tracking(
    c: &Capabilities,
    r: &Request,
    timestamp: u64,
    predicted_for: Option<u64>,
    values: &[Option<Value>],
) -> Vec<u8> {
    assert_eq!(r.samples.len(), values.len());
    let encoded: Vec<_> = r
        .samples
        .iter()
        .zip(values)
        .map(|(s, v)| {
            v.as_ref()
                .and_then(|v| encode_value(v, c.descriptors[s.descriptor as usize].kind, s.format))
        })
        .collect();
    let mut b = Vec::new();
    u32_bytes(&mut b, r.id);
    assert!(timestamp < u64::MAX && predicted_for != Some(u64::MAX));
    b.extend(timestamp.to_le_bytes());
    b.extend(predicted_for.unwrap_or(u64::MAX).to_le_bytes());
    b.resize(20 + r.samples.len().div_ceil(8), 0);
    let booleans: Vec<_> = r
        .samples
        .iter()
        .zip(&encoded)
        .filter_map(|(s, v)| {
            if s.format == 1 {
                v.as_ref().map(|v| v[0])
            } else {
                None
            }
        })
        .collect();
    let bool_at = b.len();
    b.resize(bool_at + booleans.len().div_ceil(8), 0);
    for (i, v) in booleans.iter().enumerate() {
        b[bool_at + i / 8] |= v << (i % 8);
    }
    for (i, (s, value)) in r.samples.iter().zip(encoded).enumerate() {
        if let Some(value) = value {
            b[20 + i / 8] |= 1 << (i % 8);
            if s.format != 1 {
                b.extend(value);
            }
        }
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_capabilities(v: &serde_json::Value) -> Capabilities {
        let index = |v: &serde_json::Value, field: &str| v[field].as_u64().map(|n| n as u32);
        Capabilities {
            groups: v["sample_groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["max_sample_rate_hz"].as_f64().unwrap() as f32)
                .collect(),
            descriptors: v["sample_descriptors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| Descriptor {
                    id: d["id"].as_str().unwrap().into(),
                    name: d["name"].as_str().unwrap().into(),
                    description: d["description"].as_str().unwrap().into(),
                    kind: d["kind"].as_u64().unwrap() as u8,
                    group: index(d, "group").unwrap(),
                    formats: d["supported_formats"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|f| f.as_u64().unwrap() as u8)
                        .collect(),
                    spaces: d["supported_spaces"].as_array().map_or_else(Vec::new, |s| {
                        s.iter().map(|v| v.as_u64().unwrap() as u8).collect()
                    }),
                    press_count_sample: index(d, "press_count_sample"),
                    release_count_sample: index(d, "release_count_sample"),
                    touch_count_sample: index(d, "touch_count_sample"),
                    untouch_count_sample: index(d, "untouch_count_sample"),
                    position_valid_sample: index(d, "position_valid_sample"),
                    orientation_valid_sample: index(d, "orientation_valid_sample"),
                    position_tracked_sample: index(d, "position_tracked_sample"),
                    orientation_tracked_sample: index(d, "orientation_tracked_sample"),
                    confidence_sample: index(d, "confidence_sample"),
                    revision_of: index(d, "revision_of"),
                })
                .collect(),
            skeletons: v["skeletons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    s["joints"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|j| Joint {
                            parent: index(j, "parent").unwrap(),
                            pose_sample: index(j, "pose_sample").unwrap(),
                            rest_pose_sample: index(j, "rest_pose_sample").unwrap(),
                        })
                        .collect()
                })
                .collect(),
        }
    }
    fn fixture_schedule(v: &serde_json::Value) -> Schedule {
        if v["kind"] == "OnChange" {
            Schedule::OnChange
        } else {
            Schedule::Periodic {
                interval: v["interval"].as_str().unwrap().parse().unwrap(),
                phase: v["phase"].as_str().unwrap().parse().unwrap(),
                consumption_delay: v["consumption_delay"].as_str().unwrap().parse().unwrap(),
            }
        }
    }
    fn fixture_request(v: &serde_json::Value) -> Request {
        Request {
            id: v["subscription_id"].as_u64().unwrap() as u32,
            group: v["selection"]["group"].as_u64().unwrap() as u32,
            delivery: v["channel"].as_u64().unwrap() as u8,
            schedule: fixture_schedule(&v["schedule"]),
            samples: v["selection"]["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| Selection {
                    descriptor: s["descriptor"].as_u64().unwrap() as u32,
                    format: s["format"].as_u64().unwrap() as u8,
                    space: s["reference_space"].as_u64().unwrap_or(0) as u8,
                })
                .collect(),
        }
    }
    #[test]
    fn shared_control_publication_and_clock_vectors() {
        let f = fixture();
        assert_eq!(f["protocol_version"], 1);
        for record in f["records"].as_array().unwrap() {
            let v = &record["value"];
            let id = || v["subscription_id"].as_u64().unwrap() as u32;
            let message = match record["tag"].as_u64().unwrap() {
                1 => Message::Offer(
                    v["supported_versions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u16)
                        .collect(),
                ),
                2 => Message::Selection(v["selected_version"].as_u64().unwrap() as u16),
                3 => {
                    let mut v = f["capabilities"][record["capabilities"].as_str().unwrap()].clone();
                    if let Some(skeletons) = record.get("skeletons") {
                        v["skeletons"] = skeletons.clone();
                    }
                    let c = fixture_capabilities(&v);
                    c.validate().unwrap();
                    Message::Capabilities(c)
                }
                4 => {
                    let setup = &f["requests"][record["request"].as_str().unwrap()];
                    let c = fixture_capabilities(
                        &f["capabilities"][setup["capabilities"].as_str().unwrap()],
                    );
                    let r = fixture_request(&setup["value"]);
                    c.validate_request(&r).unwrap();
                    let wire = hex(record["hex"].as_str().unwrap());
                    assert_eq!(decode_subscription(&wire[5..], &c).unwrap(), r);
                    for end in 0..wire.len() - 5 {
                        assert!(decode_subscription(&wire[5..5 + end], &c).is_err());
                    }
                    Message::Subscribe(r)
                }
                5 => Message::Accepted { id: id() },
                6 => Message::Rejected {
                    id: id(),
                    reason: v["reason"].as_str().map(str::to_owned),
                },
                7 => Message::Unsubscribe { id: id() },
                8 => Message::Ended {
                    id: id(),
                    reason: v["reason"].as_str().unwrap().into(),
                },
                12 => Message::UpdateSchedule {
                    id: id(),
                    schedule: fixture_schedule(&v["schedule"]),
                },
                tag => panic!("Unhandled fixture record {tag}"),
            };
            let expected = hex(record["hex"].as_str().unwrap());
            assert_eq!(encode(&message), expected, "{}", record["name"]);
            if matches!(
                message,
                Message::Offer(_)
                    | Message::Subscribe(_)
                    | Message::Unsubscribe { .. }
                    | Message::UpdateSchedule { .. }
            ) {
                assert_eq!(
                    ControlDecoder::default().feed(&expected).unwrap(),
                    [if matches!(message, Message::Subscribe(_)) {
                        Message::SubscribeBody(expected[5..].to_vec())
                    } else {
                        message
                    }]
                );
            }
        }
        let c = fixture_capabilities(&f["capabilities"]["device"]);
        let mut invalid = c.clone();
        invalid.descriptors[0].press_count_sample = Some(u32::MAX);
        assert!(invalid.validate().is_err());
        invalid = c.clone();
        invalid.skeletons[0][0].pose_sample = 0;
        assert!(invalid.validate().is_err());
        invalid = c;
        invalid.descriptors[14].revision_of = Some(u32::MAX);
        assert!(invalid.validate().is_err());
        for publication in f["publications"].as_array().unwrap() {
            let expected = hex(publication["hex"].as_str().unwrap());
            let v = &publication["value"];
            for name in publication["requests"].as_array().unwrap() {
                let setup = &f["requests"][name.as_str().unwrap()];
                let c = fixture_capabilities(
                    &f["capabilities"][setup["capabilities"].as_str().unwrap()],
                );
                let r = fixture_request(&setup["value"]);
                c.validate_request(&r).unwrap();
                let values: Vec<_> = v["values"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(&r.samples)
                    .map(|(v, s)| {
                        if v.is_null() {
                            return None;
                        }
                        Some(match s.format {
                            1 => Value::Bit(v.as_bool().unwrap()),
                            2..=5 => Value::Unsigned(v.as_u64().unwrap()),
                            6..=9 => Value::Signed(v.as_i64().unwrap()),
                            _ => Value::Numbers(if let Some(parts) = v.as_array() {
                                parts.iter().map(|n| n.as_f64().unwrap()).collect()
                            } else {
                                vec![v.as_f64().unwrap()]
                            }),
                        })
                    })
                    .collect();
                assert_eq!(
                    tracking(
                        &c,
                        &r,
                        v["acquired_at"].as_str().unwrap().parse().unwrap(),
                        v["predicted_for"].as_str().map(|n| n.parse().unwrap()),
                        &values
                    ),
                    expected,
                    "{} / {}",
                    publication["name"],
                    name
                );
            }
            if let Some(wire) = publication["reliable_hex"].as_str() {
                assert_eq!(encode(&Message::Publication(expected)), hex(wire));
            }
        }
        for datagram in f["datagrams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["tag"] == 11)
        {
            let v = &datagram["value"];
            assert_eq!(
                clock_response(
                    v["request_id"].as_u64().unwrap() as u32,
                    v["received_at"].as_str().unwrap().parse().unwrap(),
                    v["sent_at"].as_str().unwrap().parse().unwrap()
                ),
                hex(datagram["hex"].as_str().unwrap())
            );
        }
    }
    #[test]
    fn reliable_delivery_can_exceed_datagram_limits_and_initial_state_predates_acceptance() {
        let mut c = capabilities();
        c.descriptors[0].kind = 10;
        c.descriptors[0].formats = vec![11];
        c.descriptors[0].spaces = vec![2];
        let mut s = Session::new(c);
        s.handle(Message::Offer(vec![1]), 0).unwrap();
        s.packet_limit = 21;
        let r = Request {
            id: 1,
            group: 0,
            delivery: 2,
            schedule: Schedule::Periodic {
                interval: 16_666_667,
                phase: 0,
                consumption_delay: 0,
            },
            samples: vec![Selection {
                descriptor: 0,
                format: 11,
                space: 2,
            }],
        };
        assert!(matches!(
            s.handle(Message::Subscribe(r.clone()), 100).unwrap()[0],
            Message::Accepted { .. }
        ));
        assert_eq!(s.active[&1].timestamp(99, 100), Some(99));
        let mut unreliable = r.clone();
        unreliable.delivery = 1;
        assert!(matches!(
            s.handle(Message::Subscribe(unreliable), 101).unwrap()[0],
            Message::Rejected { .. }
        ));
        assert_eq!(s.active[&1].request.delivery, 2);
        let mut invalid = r;
        invalid.delivery = 0;
        assert!(matches!(
            s.handle(Message::Subscribe(invalid), 102).unwrap()[0],
            Message::Rejected { .. }
        ));
    }
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../protocol/testdata/specification-v1.json"
        ))
        .unwrap()
    }
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    fn capabilities() -> Capabilities {
        Capabilities {
            skeletons: vec![],
            groups: vec![200.],
            descriptors: [(2, 1), (3, 2), (4, 2), (8, 12)]
                .into_iter()
                .enumerate()
                .map(|(i, (kind, format))| Descriptor {
                    id: i.to_string(),
                    name: "".into(),
                    description: "".into(),
                    kind,
                    formats: vec![format],
                    group: 0,
                    spaces: vec![],
                    ..Descriptor::default()
                })
                .collect(),
        }
    }
    fn request() -> Request {
        Request {
            id: 7,
            group: 0,
            delivery: 1,
            schedule: Schedule::Periodic {
                interval: 16_666_667,
                phase: 5_000_000,
                consumption_delay: 25_000_000,
            },
            samples: [1, 2, 12]
                .into_iter()
                .enumerate()
                .map(|(i, format)| Selection {
                    descriptor: if i == 2 { 3 } else { i as u32 },
                    format,
                    space: 0,
                })
                .collect(),
        }
    }
    fn session() -> Session {
        let mut s = Session::new(capabilities());
        assert_eq!(s.handle(Message::Offer(vec![1]), 0).unwrap().len(), 2);
        s
    }
    #[test]
    fn boolean_slots_filter_unavailable_samples_across_bitmap_bytes() {
        let c = Capabilities {
            skeletons: vec![],
            groups: vec![60.],
            descriptors: (0..9)
                .map(|i| Descriptor {
                    id: i.to_string(),
                    name: "".into(),
                    description: "".into(),
                    kind: 2,
                    formats: vec![1],
                    group: 0,
                    spaces: vec![],
                    ..Descriptor::default()
                })
                .collect(),
        };
        let r = Request {
            id: 1,
            group: 0,
            delivery: 1,
            schedule: Schedule::Periodic {
                interval: 16_666_667,
                phase: 0,
                consumption_delay: 0,
            },
            samples: (0..9)
                .map(|descriptor| Selection {
                    descriptor,
                    format: 1,
                    space: 0,
                })
                .collect(),
        };
        let mut values: Vec<_> = (0..9)
            .map(|i| {
                if i == 0 {
                    None
                } else {
                    Some(Value::Bit(i % 2 == 0))
                }
            })
            .collect();
        assert_eq!(
            &tracking(&c, &r, 0, None, &values)[20..],
            &[0xfe, 0x01, 0xaa]
        );
        values[8] = None;
        assert_eq!(
            &tracking(&c, &r, 0, None, &values)[20..],
            &[0xfe, 0x00, 0x2a]
        );
    }
    #[test]
    fn schedules_keep_phase_skip_missed_slots_and_allow_repeated_acquisitions() {
        let mut s = session();
        let schedule = Schedule::Periodic {
            interval: 10_000_000,
            phase: 3_000_000,
            consumption_delay: 5_000_000,
        };
        assert_eq!(schedule.next_at(3_000_000), Some(3_000_000));
        assert_eq!(schedule.next_at(3_000_001), Some(13_000_000));
        s.handle(
            Message::Subscribe(Request {
                schedule: schedule.clone(),
                ..request()
            }),
            2_000_000,
        )
        .unwrap();
        let sub = s.active.get_mut(&7).unwrap();
        assert!(
            sub.due(2_000_000),
            "Initial state is immediate before the first scheduled slot"
        );
        assert_eq!(sub.timestamp(1, 2_000_000), Some(1));
        sub.published(&[0; 20]);
        assert!(!sub.due(2_999_999));
        assert!(sub.due(3_000_000));
        sub.advance(3_000_000).unwrap();
        assert_eq!(sub.next_due, Some(13_000_000));
        assert_eq!(
            sub.timestamp(3_000_001, 3_000_002),
            Some(3_000_001),
            "An acquisition between scheduling and copying the sample remains publishable"
        );
        assert_eq!(
            sub.timestamp(1, 13_000_000),
            Some(1),
            "Periodic can repeat an acquisition"
        );
        sub.advance(95_000_000).unwrap();
        assert_eq!(sub.next_due, Some(103_000_000));
        let selection = sub.request.samples.clone();
        s.handle(
            Message::UpdateSchedule {
                id: 7,
                schedule: Schedule::OnChange,
            },
            100_000_000,
        )
        .unwrap();
        let sub = &s.active[&7];
        assert_eq!(sub.request.samples, selection);
        assert!(
            !sub.should_publish(&[0; 20]),
            "Schedule update preserves value baseline"
        );
        s.handle(Message::UpdateSchedule { id: 7, schedule }, 100_000_000)
            .unwrap();
        assert_eq!(s.active[&7].next_due, Some(103_000_000));
        for interval in [0, 1, u64::MAX] {
            assert!(
                s.handle(
                    Message::UpdateSchedule {
                        id: 7,
                        schedule: Schedule::Periodic {
                            interval,
                            phase: 0,
                            consumption_delay: 0
                        }
                    },
                    0
                )
                .is_err()
            );
        }
        assert!(
            Schedule::Periodic {
                interval: 10,
                phase: u64::MAX - 1,
                consumption_delay: 0
            }
            .validate(f32::MAX, 0)
            .is_ok()
        );
        assert!(
            Schedule::Periodic {
                interval: 10,
                phase: 0,
                consumption_delay: u64::MAX - 1
            }
            .validate(f32::MAX, 10)
            .is_err()
        );
        assert!(
            s.handle(
                Message::UpdateSchedule {
                    id: 999,
                    schedule: Schedule::OnChange
                },
                0
            )
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn segmented_control() {
        let bytes = [
            encode(&Message::Offer(vec![1])),
            encode(&Message::Subscribe(request())),
        ]
        .concat();
        for split in 0..=bytes.len() {
            let mut d = ControlDecoder::default();
            let mut got = d.feed(&bytes[..split]).unwrap();
            got.extend(d.feed(&bytes[split..]).unwrap());
            assert_eq!(
                got,
                vec![
                    Message::Offer(vec![1]),
                    Message::SubscribeBody(encode(&Message::Subscribe(request()))[5..].to_vec())
                ]
            );
        }
    }
    #[test]
    fn all_formats_and_invalid_source_values() {
        for entry in fixture()["formats"].as_array().unwrap() {
            let f = entry["format"].as_u64().unwrap() as u8;
            let n = entry["value"].as_str().unwrap();
            let value = match f {
                1 => Value::Bit(true),
                2..=5 => Value::Unsigned(n.parse().unwrap()),
                6..=9 => Value::Signed(n.parse().unwrap()),
                _ => Value::Numbers(vec![n.parse().unwrap()]),
            };
            assert_eq!(
                encode_value(&value, 1, f).unwrap(),
                hex(entry["hex"].as_str().unwrap())
            );
        }
        assert!(encode_value(&Value::Unsigned(256), 1, 2).is_none());
        assert_eq!(encode_value(&Value::Unsigned(256), 3, 2).unwrap(), [0]);
        assert!(encode_value(&Value::Signed(128), 1, 6).is_none());
        for f in [10, 11, 12, 13] {
            for n in [
                f64::NAN,
                f64::INFINITY,
                -0.1,
                1.1,
                1.0 + f64::EPSILON,
                -f64::EPSILON,
            ] {
                assert!(encode_value(&Value::Numbers(vec![n]), 8, f).is_none());
            }
        }
        assert_eq!(
            encode_value(&Value::Numbers(vec![2.5 / 255.]), 8, 12).unwrap(),
            [2]
        );
        assert_eq!(
            encode_value(&Value::Numbers(vec![3.5 / 255.]), 8, 12).unwrap(),
            [4]
        );
        assert!(encode_value(&Value::Numbers(vec![f64::NAN]), 1, 11).is_some());
        for f in [10, 11] {
            let tolerance: f64 = if f == 10 { 1e-5 } else { 1e-12 };
            for (error, expected) in [(tolerance / 2., true), (tolerance * 2., false)] {
                assert_eq!(
                    valid_numbers(10, f, &[0., 0., 0., 0., 0., 0., (1. + error).sqrt()]),
                    expected
                );
            }
            assert!(!valid_numbers(10, f, &[0.; 7]));
        }
    }
    #[test]
    fn all_channels_and_schedules_replacement_rejection_unsubscribe_and_reconnect() {
        for delivery in [1, 2] {
            for schedule in [Schedule::OnChange, request().schedule] {
                let mut s = session();
                let r = Request {
                    delivery,
                    schedule,
                    ..request()
                };
                assert_eq!(
                    s.handle(Message::Subscribe(r.clone()), 0).unwrap(),
                    [Message::Accepted { id: 7 }]
                );
                let mut bad = r.clone();
                bad.samples[0].format = 255;
                assert!(matches!(
                    s.handle(Message::Subscribe(bad), 1).unwrap()[0],
                    Message::Rejected { .. }
                ));
                assert_eq!(s.active[&7].request, r);
                assert!(matches!(
                    s.handle(Message::Subscribe(r.clone()), 2)
                        .unwrap()
                        .as_slice(),
                    [Message::Ended { id: 7, .. }, Message::Accepted { id: 7 }]
                ));
                assert_eq!(
                    s.handle(Message::Unsubscribe { id: 7 }, 3).unwrap().len(),
                    1
                );
                assert!(s.active.is_empty());
                assert_eq!(
                    s.handle(Message::Unsubscribe { id: 7 }, 4).unwrap().len(),
                    1
                );
                s.handle(Message::Subscribe(r), 5).unwrap();
                assert_eq!(s.end(7, "Device lost").len(), 1);
                assert!(s.handle(Message::Offer(vec![1]), 6).is_err());
                assert!(session().active.is_empty());
            }
        }
    }
    #[test]
    fn malformed_controls_and_readable_rejections() {
        for bytes in [
            vec![0, 0, 0, 0],
            vec![255, 255, 255, 255],
            vec![1, 0, 0, 0, 255],
            encode(&Message::Selection(1)),
            encode(&Message::Offer(vec![])),
            encode(&Message::Offer(vec![0])),
            encode(&Message::Offer(vec![1, 1])),
        ] {
            assert!(ControlDecoder::default().feed(&bytes).is_err());
        }
        let mut s = session();
        for mutation in 0..8 {
            let mut r = request();
            match mutation {
                0 => r.group = 1,
                1 => {
                    r.schedule = Schedule::Periodic {
                        interval: 0,
                        phase: 0,
                        consumption_delay: 0,
                    }
                }
                2 => {
                    r.schedule = Schedule::Periodic {
                        interval: 1,
                        phase: 0,
                        consumption_delay: 0,
                    }
                }
                3 => r.samples.clear(),
                4 => r.samples[0].descriptor = 999,
                5 => r.samples.push(r.samples[0].clone()),
                6 => r.samples[0].space = 2,
                _ => {
                    r.schedule = Schedule::Periodic {
                        interval: u64::MAX,
                        phase: 0,
                        consumption_delay: 0,
                    }
                }
            }
            assert!(matches!(
                s.handle(Message::Subscribe(r), 0).unwrap()[0],
                Message::Rejected { .. }
            ));
        }
        for body in [vec![0], vec![0; 12], vec![0; 20]] {
            assert!(s.handle(Message::SubscribeBody(body), 0).is_err());
        }
        assert_eq!(
            Session::new(capabilities())
                .handle(Message::Offer(vec![2]), 0)
                .unwrap(),
            [Message::Selection(0)]
        );
    }
    #[test]
    fn invalid_advertisements_and_pose_selections() {
        let mut c = capabilities();
        c.descriptors[0].formats = vec![10];
        assert!(c.validate().is_err());
        let mut c = capabilities();
        c.descriptors[0].spaces = vec![2];
        assert!(c.validate().is_err());
        let mut c = capabilities();
        c.descriptors[0].kind = 10;
        c.descriptors[0].formats = vec![10, 11];
        c.descriptors[0].spaces = vec![4];
        assert!(c.validate().is_ok());
        let mut r = request();
        r.samples[0].format = 11;
        r.samples[0].space = 2;
        assert!(c.validate_request(&r).is_err());
        r.samples[0].space = 4;
        assert!(c.validate_request(&r).is_ok());
        c.descriptors[1].id = c.descriptors[0].id.clone();
        assert!(c.validate().is_err());
    }
}
