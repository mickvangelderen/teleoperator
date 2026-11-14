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
pub struct Request {
    pub id: u32,
    pub group: u32,
    pub delivery: u8,
    pub rate: f32,
    pub samples: Vec<Selection>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Publication(Vec<u8>),
    Offer(Vec<u16>),
    Selection(u16),
    Capabilities(Capabilities),
    Subscribe(Request),
    Accepted {
        id: u32,
        generation: u32,
    },
    Rejected {
        id: u32,
        reason: String,
    },
    Unsubscribe {
        id: u32,
        generation: u32,
    },
    Ended {
        id: u32,
        generation: u32,
        reason: String,
    },
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
    pub fn rest_group(&self, group: u32) -> bool {
        let rest: HashSet<_> = self
            .skeletons
            .iter()
            .flatten()
            .map(|j| j.rest_pose_sample)
            .collect();
        self.descriptors
            .iter()
            .enumerate()
            .any(|(i, d)| d.group == group && rest.contains(&(i as u32)))
            && self
                .descriptors
                .iter()
                .enumerate()
                .all(|(i, d)| d.group != group || rest.contains(&(i as u32)) || d.kind == 11)
    }
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
                        || d.spaces.iter().any(|s| !(1..=5).contains(s))
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
        if !r.rate.is_finite()
            || r.rate <= 0.
            || r.rate > *max
            || 1e9 / r.rate as f64 >= i64::MAX as f64
        {
            return Err("Unsupported publication rate".into());
        }
        if r.samples.is_empty() {
            return Err("Select at least one sample".into());
        }
        let mut seen = HashSet::new();
        let mut size = 16 + r.samples.len().div_ceil(8);
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
            let id = r.u32()?;
            let group = r.u32()?;
            let delivery = r.u8()?;
            let rate = f32::from_bits(r.u32()?);
            let n = r.count(6)?;
            let mut samples = Vec::with_capacity(n);
            for _ in 0..n {
                samples.push(Selection {
                    descriptor: r.u32()?,
                    format: r.u8()?,
                    space: r.u8()?,
                });
            }
            Message::Subscribe(Request {
                id,
                group,
                delivery,
                rate,
                samples,
            })
        }
        7 => Message::Unsubscribe {
            id: r.u32()?,
            generation: r.u32()?,
        },
        _ => return Err("Invalid client message tag or direction".into()),
    };
    if r.at != body.len() {
        return Err("Trailing control bytes".into());
    }
    Ok(message)
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
            b.push(r.delivery);
            b.extend(r.rate.to_le_bytes());
            u32_bytes(&mut b, r.samples.len() as u32);
            for s in &r.samples {
                u32_bytes(&mut b, s.descriptor);
                b.extend([s.format, s.space]);
            }
        }
        Message::Accepted { id, generation } | Message::Unsubscribe { id, generation } => {
            b.push(if matches!(message, Message::Accepted { .. }) {
                5
            } else {
                7
            });
            u32_bytes(&mut b, *id);
            u32_bytes(&mut b, *generation);
        }
        Message::Rejected { id, reason } => {
            b.push(6);
            u32_bytes(&mut b, *id);
            string(&mut b, reason);
        }
        Message::Publication(body) => {
            b.push(9);
            b.extend(body);
        }
        Message::Ended {
            id,
            generation,
            reason,
        } => {
            b.push(8);
            u32_bytes(&mut b, *id);
            u32_bytes(&mut b, *generation);
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
    pub generation: u32,
    pub next_due: i64,
    pub last_acquired: Option<i64>,
    pub on_change: bool,
    last_publication: Option<(Option<u64>, Vec<u8>)>,
}
impl Subscription {
    pub fn timestamp(&self, acquired: i64, epoch: i64, now: i64) -> Option<u64> {
        if acquired > now
            || self.last_acquired.is_some_and(|t| acquired <= t)
            || (!self.on_change && now < self.next_due)
        {
            return None;
        }
        acquired
            .checked_sub(epoch)
            .and_then(|v| u64::try_from(v).ok())
    }
    pub fn should_publish(&self, revision: Option<u64>, body: &[u8]) -> bool {
        !self.on_change
            || self
                .last_publication
                .as_ref()
                .is_none_or(|(previous_revision, previous)| {
                    *previous_revision != revision || previous != &body[16..]
                })
    }
    pub fn published(&mut self, acquired: i64, now: i64, revision: Option<u64>, body: &[u8]) {
        self.last_acquired = Some(acquired);
        if self.on_change {
            // Ignore the id, generation and acquisition timestamp when comparing snapshots.
            self.last_publication = Some((revision, body[16..].to_vec()));
            return;
        }
        let period = (1e9 / self.request.rate as f64).ceil() as i64;
        let steps = (now - self.next_due) / period + 1;
        self.next_due = self.next_due.saturating_add(period.saturating_mul(steps));
    }
}

pub struct Session {
    pub capabilities: Capabilities,
    pub negotiated: bool,
    pub packet_limit: usize,
    pub active: BTreeMap<u32, Subscription>,
    issued: BTreeMap<u32, u32>,
    next_generation: u32,
}
impl Session {
    pub fn new(capabilities: Capabilities) -> Self {
        Self {
            capabilities,
            negotiated: false,
            packet_limit: MAX_PACKET,
            active: BTreeMap::new(),
            issued: BTreeMap::new(),
            next_generation: 1,
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
        match message {
            Message::Subscribe(request) => {
                let id = request.id;
                let validation = self
                    .capabilities
                    .validate_request(&request)
                    .and_then(|size| {
                        if request.delivery == 1 && size + 1 > self.packet_limit {
                            return Err("Tracking packet exceeds negotiated transport limit".into());
                        }
                        if self.active.len() >= MAX_SUBSCRIPTIONS && !self.active.contains_key(&id)
                        {
                            Err("Subscription limit".into())
                        } else {
                            Ok(())
                        }
                    });
                if let Err(reason) = validation {
                    return Ok(vec![Message::Rejected { id, reason }]);
                }
                // Bound connection history as well as active subscriptions. Reconnect starts fresh.
                if self.issued.len() >= 65_536 || self.next_generation == u32::MAX {
                    return Err("Generation resource limit; reconnect".into());
                }
                let mut replies = self.end(id, "Replaced by a new subscription");
                let generation = self.next_generation;
                self.next_generation += 1;
                self.issued.insert(generation, id);
                self.active.insert(
                    id,
                    Subscription {
                        on_change: request.delivery == 2
                            && self.capabilities.rest_group(request.group),
                        last_publication: None,
                        request,
                        generation,
                        next_due: now,
                        last_acquired: None,
                    },
                );
                replies.push(Message::Accepted { id, generation });
                Ok(replies)
            }
            Message::Unsubscribe { id, generation } => {
                if self.issued.get(&generation) != Some(&id) {
                    return Err(
                        "Unsubscription must identify a previously accepted generation".into(),
                    );
                }
                if self
                    .active
                    .get(&id)
                    .is_some_and(|s| s.generation == generation)
                {
                    Ok(self.end(id, "Unsubscribed"))
                } else {
                    Ok(vec![Message::Ended {
                        id,
                        generation,
                        reason: "Generation is no longer active".into(),
                    }])
                }
            }
            _ => Err("Message in invalid session phase".into()),
        }
    }
    pub fn end(&mut self, id: u32, reason: &str) -> Vec<Message> {
        self.active
            .remove(&id)
            .map(|s| {
                vec![Message::Ended {
                    id,
                    generation: s.generation,
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
    generation: u32,
    timestamp: u64,
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
    u32_bytes(&mut b, generation);
    b.extend(timestamp.to_le_bytes());
    b.resize(16 + r.samples.len().div_ceil(8), 0);
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
            b[16 + i / 8] |= 1 << (i % 8);
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
    #[test]
    fn revised_capabilities_reliable_publications_and_clock_vectors() {
        let spec: serde_json::Value = serde_json::from_str(include_str!(
            "../../protocol/testdata/specification-v1.json"
        ))
        .unwrap();
        let index = |v: &serde_json::Value, field: &str| v[field].as_u64().map(|n| n as u32);
        for record in spec["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["tag"] == 3)
        {
            let v = &record["value"];
            let c = Capabilities {
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
            };
            c.validate().unwrap();
            assert_eq!(
                encode(&Message::Capabilities(c.clone())),
                hex(record["hex"].as_str().unwrap())
            );
            let mut invalid = c.clone();
            invalid.descriptors[0].press_count_sample = Some(u32::MAX);
            assert!(invalid.validate().is_err());
            invalid = c.clone();
            invalid.skeletons[0][0].pose_sample = 0;
            assert!(invalid.validate().is_err());
            invalid = c;
            invalid.descriptors[14].revision_of = Some(u32::MAX);
            assert!(invalid.validate().is_err());
        }
        for publication in spec["publications"].as_array().unwrap() {
            if let Some(expected) = publication["reliable_hex"].as_str() {
                assert_eq!(
                    encode(&Message::Publication(hex(publication["hex"]
                        .as_str()
                        .unwrap()))),
                    hex(expected)
                );
            }
        }
        for datagram in spec["datagrams"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["tag"] == 11)
        {
            let v = &datagram["value"];
            assert_eq!(
                clock_response(
                    index(v, "request_id").unwrap(),
                    v["received_at_ns"].as_str().unwrap().parse().unwrap(),
                    v["sent_at_ns"].as_str().unwrap().parse().unwrap()
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
            rate: 60.,
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
        assert_eq!(s.active[&1].timestamp(99, 0, 100), Some(99));
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
        serde_json::from_str(include_str!("../../protocol/testdata/protocol-v1.json")).unwrap()
    }
    fn vector(f: &serde_json::Value, name: &str) -> Vec<u8> {
        if name == "request" {
            let spec: serde_json::Value = serde_json::from_str(include_str!(
                "../../protocol/testdata/specification-v1.json"
            ))
            .unwrap();
            return hex(spec["records"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == "request_inputs")
                .unwrap()["hex"]
                .as_str()
                .unwrap());
        }
        let entry = f["control"]
            .as_array()
            .unwrap()
            .iter()
            .chain(f["tracking"].as_array().unwrap())
            .find(|entry| entry["name"] == name)
            .unwrap();
        hex(entry["hex"].as_str().unwrap())
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
            rate: 60.,
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
            rate: 60.,
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
        assert_eq!(&tracking(&c, &r, 1, 0, &values)[16..], &[0xfe, 0x01, 0xaa]);
        values[8] = None;
        assert_eq!(&tracking(&c, &r, 1, 0, &values)[16..], &[0xfe, 0x00, 0x2a]);
    }
    #[test]
    fn publisher_uses_fresh_connection_times_and_skips_missed_rate_slots() {
        let mut s = session();
        s.handle(Message::Subscribe(request()), 1_000_000_000)
            .unwrap();
        let sub = s.active.get_mut(&7).unwrap();
        assert_eq!(
            sub.timestamp(999_999_999, 1_000_000_000, 1_000_000_001),
            None
        );
        assert_eq!(
            sub.timestamp(1_000_000_000, 1_000_000_000, 1_000_000_001),
            Some(0)
        );
        assert_eq!(
            sub.timestamp(1_000_000_001, 1_000_000_000, 1_000_000_001),
            Some(1)
        );
        assert_eq!(
            sub.timestamp(1_000_000_002, 1_000_000_000, 1_000_000_001),
            None
        );
        let mut sent = 0;
        for i in 1..=200 {
            let t = 1_000_000_000 + i * 5_000_000;
            if sub.timestamp(t, 1_000_000_000, t).is_some() {
                sent += 1;
                sub.published(t, t, None, &[]);
                assert_eq!(sub.timestamp(t, 1_000_000_000, t), None);
            }
        }
        assert_eq!(sent, 60);
        let delayed = 10_000_000_000;
        assert!(sub.timestamp(delayed, 1_000_000_000, delayed).is_some());
        sub.published(delayed, delayed, None, &[]);
        assert!(sub.next_due > delayed);
        assert_eq!(sub.timestamp(delayed + 1, 1_000_000_000, delayed + 1), None);
        let mut limited = session();
        limited.packet_limit = 20;
        assert!(matches!(
            limited.handle(Message::Subscribe(request()), 0).unwrap()[0],
            Message::Rejected { .. }
        ));
        limited.packet_limit = 21;
        assert!(matches!(
            limited.handle(Message::Subscribe(request()), 0).unwrap()[0],
            Message::Accepted { .. }
        ));
    }
    #[test]
    fn exact_specification_vectors_and_segmented_control() {
        let f = fixture();
        assert_eq!(f["fixture_version"], 1);
        assert_eq!(f["protocol_version"], 1);
        for (name, message) in [
            ("offer", Message::Offer(vec![1])),
            ("selection", Message::Selection(1)),
            ("request", Message::Subscribe(request())),
            (
                "acceptance",
                Message::Accepted {
                    id: 7,
                    generation: 2,
                },
            ),
            (
                "rejection",
                Message::Rejected {
                    id: 7,
                    reason: "Rate unavailable".into(),
                },
            ),
            (
                "unsubscribe",
                Message::Unsubscribe {
                    id: 7,
                    generation: 2,
                },
            ),
            (
                "ended",
                Message::Ended {
                    id: 7,
                    generation: 2,
                    reason: "Device lost".into(),
                },
            ),
        ] {
            let expected = vector(&f, name);
            assert_eq!(encode(&message), expected, "{name}");
            if matches!(
                message,
                Message::Offer(_) | Message::Subscribe(_) | Message::Unsubscribe { .. }
            ) {
                assert_eq!(
                    ControlDecoder::default().feed(&expected).unwrap(),
                    [message]
                );
            }
        }
        let values = vec![
            Some(Value::Bit(true)),
            Some(Value::Unsigned(254)),
            Some(Value::Numbers(vec![128. / 255.])),
        ];
        assert_eq!(
            tracking(&capabilities(), &request(), 2, 1_000_000_000, &values),
            vector(&f, "available")
        );
        let values = vec![
            None,
            Some(Value::Unsigned(1)),
            Some(Value::Numbers(vec![0.])),
        ];
        assert_eq!(
            tracking(&capabilities(), &request(), 2, 1_020_000_000, &values),
            vector(&f, "missing_boolean")
        );
        assert_eq!(
            tracking(
                &capabilities(),
                &request(),
                2,
                1_020_000_000,
                &[None, None, None]
            ),
            vector(&f, "all_missing")
        );
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
                vec![Message::Offer(vec![1]), Message::Subscribe(request())]
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
    fn validation_replacement_unsubscribe_and_server_termination() {
        let mut s = session();
        let r = request();
        assert_eq!(
            s.handle(Message::Subscribe(r.clone()), 10).unwrap(),
            vec![Message::Accepted {
                id: 7,
                generation: 1
            }]
        );
        let mut bad = r.clone();
        bad.samples[0].format = 255;
        assert!(matches!(
            s.handle(Message::Subscribe(bad), 20).unwrap()[0],
            Message::Rejected { .. }
        ));
        assert_eq!(s.active[&7].generation, 1);
        let replies = s.handle(Message::Subscribe(r.clone()), 30).unwrap();
        assert!(matches!(
            replies.as_slice(),
            [
                Message::Ended { generation: 1, .. },
                Message::Accepted { generation: 2, .. }
            ]
        ));
        s.handle(
            Message::Unsubscribe {
                id: 7,
                generation: 1,
            },
            40,
        )
        .unwrap();
        assert_eq!(s.active[&7].generation, 2);
        s.handle(
            Message::Unsubscribe {
                id: 7,
                generation: 2,
            },
            50,
        )
        .unwrap();
        assert!(s.active.is_empty());
        s.handle(
            Message::Unsubscribe {
                id: 7,
                generation: 2,
            },
            60,
        )
        .unwrap();
        s.handle(Message::Subscribe(r), 70).unwrap();
        assert_eq!(s.active[&7].generation, 3);
        assert_eq!(
            s.end(7, "Device lost"),
            vec![Message::Ended {
                id: 7,
                generation: 3,
                reason: "Device lost".into()
            }]
        );
        assert!(
            s.handle(
                Message::Unsubscribe {
                    id: 7,
                    generation: 999
                },
                80
            )
            .is_err()
        );
        assert!(s.handle(Message::Offer(vec![1]), 90).is_err());
        let mut fresh = session();
        fresh.handle(Message::Subscribe(request()), 1).unwrap();
        assert_eq!(fresh.active[&7].generation, 1);
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
            assert!(ControlDecoder::default().feed(&bytes).is_err(), "{bytes:?}");
        }
        let mut trailing = encode(&Message::Offer(vec![1]));
        trailing.push(0);
        trailing[0] += 1;
        assert!(ControlDecoder::default().feed(&trailing).is_err());
        let mut count = encode(&Message::Subscribe(request()));
        count[18..22].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(ControlDecoder::default().feed(&count).is_err());
        let mut s = session();
        for mutation in 0..9 {
            let mut r = request();
            match mutation {
                0 => r.group = 1,
                1 => r.rate = f32::NAN,
                2 => r.rate = 201.,
                3 => r.samples.clear(),
                4 => r.samples[0].descriptor = 999,
                5 => r.samples.push(r.samples[0].clone()),
                6 => r.samples[0].space = 2,
                7 => r.rate = f32::from_bits(1),
                _ => r.rate = 0.,
            }
            let parsed = ControlDecoder::default()
                .feed(&encode(&Message::Subscribe(r)))
                .unwrap()
                .remove(0);
            assert!(matches!(
                s.handle(parsed, 0).unwrap()[0],
                Message::Rejected { .. }
            ));
        }
        let mut s = Session::new(capabilities());
        assert_eq!(
            s.handle(Message::Offer(vec![2]), 0).unwrap(),
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
