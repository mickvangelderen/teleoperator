//! Standalone protocol v1 codec and publication state.
//! Adapted from operator/src/protocol.rs at 36035521e914bcd850c901d72743ae21bd0a1047.
//! No dependency on the XR operator; transport and phone sources are separate.
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Arc;

// The pinned WebRTC callback receiver has a fixed 65,535-byte buffer.
pub const MAX_CLIENT_MESSAGE: usize = 65_535;
pub const MAX_SERVER_MESSAGE: usize = 1_048_576;
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
pub struct SampleBinding {
    pub descriptor: u32,
    pub format: u8,
    pub space: u8,
}
/// Nanosecond timing is direct protocol data, with no publication modes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    pub interval: u64,
    pub phase: u64,
    pub prediction_offset: u64,
}
impl Timing {
    pub fn validate(&self) -> Result<()> {
        if self.interval == 0
            || [self.interval, self.phase, self.prediction_offset].contains(&u64::MAX)
        {
            return Err("Invalid required duration".into());
        }
        Ok(())
    }
    pub fn next_at(&self, now: u64) -> Option<u64> {
        self.validate().ok()?;
        let offset = (self.phase as u128 + self.interval as u128
            - now as u128 % self.interval as u128)
            % self.interval as u128;
        u64::try_from(now as u128 + offset)
            .ok()
            .filter(|t| *t < u64::MAX)
    }
    pub fn target_at(&self, opportunity: u64) -> Option<u64> {
        opportunity
            .checked_add(self.prediction_offset)
            .filter(|t| *t < u64::MAX)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub id: u32,
    pub group: u32,
    pub channel: u8,
    pub interval: u64,
    pub phase: u64,
    pub prediction_offset: u64,
    pub sequence_number_format: Option<SequenceNumberFormat>,
    pub bundles: Vec<Vec<SampleBinding>>,
}
impl Request {
    pub fn timing(&self) -> Timing {
        Timing {
            interval: self.interval,
            phase: self.phase,
            prediction_offset: self.prediction_offset,
        }
    }
    pub fn bindings(&self) -> impl Iterator<Item = &SampleBinding> {
        self.bundles.iter().flatten()
    }
    pub fn validate_structure(&self, c: &Capabilities) -> Result<()> {
        self.timing().validate()?;
        if self.group == u32::MAX
            || !matches!(self.channel, 1 | 2)
            || self.bundles.is_empty()
            || (self.bundles.len() > 1 && self.sequence_number_format.is_none())
        {
            return Err("Invalid subscription structure".into());
        }
        for binding in self.bindings() {
            let d = c
                .descriptors
                .get(binding.descriptor as usize)
                .ok_or("Unknown descriptor in binding layout")?;
            if !(1..=15).contains(&binding.format)
                || (d.kind == 10 && !(1..=6).contains(&binding.space))
                || (d.kind != 10 && binding.space != 0)
            {
                return Err("Invalid binding enum or layout".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SequenceNumberFormat {
    U16 = 1,
    U32 = 2,
    U64 = 3,
}
impl SequenceNumberFormat {
    pub fn from_tag(tag: u8) -> Result<Option<Self>> {
        match tag {
            0 => Ok(None),
            1 => Ok(Some(Self::U16)),
            2 => Ok(Some(Self::U32)),
            3 => Ok(Some(Self::U64)),
            _ => Err("Invalid sequence format".into()),
        }
    }
    pub fn width(self) -> usize {
        match self {
            Self::U16 => 2,
            Self::U32 => 4,
            Self::U64 => 8,
        }
    }
    pub fn mask(self) -> u64 {
        u64::MAX >> (64 - self.width() * 8)
    }
    pub fn half(self) -> u64 {
        1 << (self.width() * 8 - 1)
    }
    pub fn next(self, sequence: u64) -> u64 {
        sequence.wrapping_add(1) & self.mask()
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Publication(Vec<u8>),
    Offer(Vec<u16>),
    Selection(u16),
    Capabilities(Arc<Capabilities>),
    Subscribe(Request),
    SubscribeBody(Vec<u8>),
    Accepted { id: u32 },
    Rejected { id: u32, reason: Option<String> },
    Unsubscribe { id: u32 },
    Ended { id: u32, reason: String },
    UpdateSchedule { id: u32, timing: Timing },
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
            if !ids.insert(&d.id)
                || d.group as usize >= self.groups.len()
                || d.formats.is_empty()
                || d.formats.iter().any(|f| !compatible(d.kind, *f))
                || (d.kind == 10
                    && (d.spaces.is_empty() || d.spaces.iter().any(|s| !(1..=6).contains(s))))
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
        let mut parent_frames = BTreeMap::<u32, u32>::new();
        for skeleton in &self.skeletons {
            for (index, joint) in skeleton.iter().enumerate() {
                let mut seen = HashSet::new();
                let mut at = index;
                while skeleton[at].parent as usize != at {
                    if !seen.insert(at) {
                        return Err("Cyclic skeleton hierarchy".into());
                    }
                    at = skeleton[at].parent as usize;
                }
                let parent = &skeleton[joint.parent as usize];
                for (descriptor, frame) in [
                    (joint.pose_sample, parent.pose_sample),
                    (joint.rest_pose_sample, parent.rest_pose_sample),
                ] {
                    if self.descriptors[descriptor as usize].spaces.contains(&5)
                        && parent_frames
                            .insert(descriptor, frame)
                            .is_some_and(|previous| previous != frame)
                    {
                        return Err("Ambiguous parent frame".into());
                    }
                }
            }
        }
        if self
            .descriptors
            .iter()
            .enumerate()
            .any(|(i, d)| d.spaces.contains(&5) && !parent_frames.contains_key(&(i as u32)))
        {
            return Err("Missing parent frame".into());
        }
        Ok(())
    }
    /// Admission limits are policy, distinct from malformed wire data.
    pub fn validate_request(&self, r: &Request) -> Result<usize> {
        r.validate_structure(self)?;
        self.admit_request(r)
    }
    fn admit_request(&self, r: &Request) -> Result<usize> {
        self.groups.get(r.group as usize).ok_or("Unknown group")?;
        if r.bundles.len() > 1024 {
            return Err("Bundle resource limit".into());
        }
        let mut size = 20usize
            + r.sequence_number_format.map_or(0, |f| f.width())
            + (r.bundles.len() - 1).div_ceil(8);
        for bundle in &r.bundles {
            let mut bits: usize = 0;
            for s in bundle {
                let d = &self.descriptors[s.descriptor as usize];
                if d.group != r.group {
                    return Err("Wrong acquisition group".into());
                }
                if !d.formats.contains(&s.format) || !compatible(d.kind, s.format) {
                    return Err("Unsupported sample format".into());
                }
                if d.kind == 10 && !d.spaces.contains(&s.space) {
                    return Err("Unsupported reference space".into());
                }
                if s.format == 1 {
                    bits += 1;
                } else {
                    size = size
                        .checked_add(components(d.kind) * width(s.format))
                        .ok_or("Publication size overflow")?;
                }
            }
            size = size
                .checked_add(bits.div_ceil(8))
                .ok_or("Publication size overflow")?;
        }
        if size >= MAX_SERVER_MESSAGE {
            return Err("Publication exceeds transport limit".into());
        }
        Ok(size)
    }
}

fn validate_offer(versions: &[u16]) -> Result<()> {
    if versions.is_empty()
        || versions.contains(&0)
        || versions.iter().collect::<HashSet<_>>().len() != versions.len()
    {
        return Err("Invalid version offer".into());
    }
    Ok(())
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
    fn timing(&mut self) -> Result<Timing> {
        let timing = Timing {
            interval: self.u64()?,
            phase: self.u64()?,
            prediction_offset: self.u64()?,
        };
        timing.validate()?;
        Ok(timing)
    }
    fn count(&mut self, minimum: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        if n > (self.bytes.len() - self.at) / minimum {
            return Err("Impossible list count".into());
        }
        Ok(n)
    }
}
pub fn decode_client(body: &[u8]) -> Result<Message> {
    decode_client_with_limit(body, MAX_CLIENT_MESSAGE)
}
/// Receiver decoding limits are independent of transport send limits.
pub fn decode_client_with_limit(body: &[u8], limit: usize) -> Result<Message> {
    if body.len() > limit.min(MAX_CLIENT_MESSAGE) {
        return Err("Message size limit".into());
    }
    let mut r = Reader { bytes: body, at: 0 };
    let message = match r.u8()? {
        1 => {
            let n = r.count(2)?;
            let mut versions = Vec::with_capacity(n);
            for _ in 0..n {
                versions.push(r.u16()?);
            }
            validate_offer(&versions)?;
            Message::Offer(versions)
        }
        4 => {
            let body = r.take(body.len() - 1)?.to_vec();
            Message::SubscribeBody(body)
        }
        7 => Message::Unsubscribe { id: r.u32()? },
        12 => Message::UpdateSchedule {
            id: r.u32()?,
            timing: r.timing()?,
        },
        _ => return Err("Invalid client message tag or direction".into()),
    };
    if r.at != body.len() {
        return Err("Trailing control bytes".into());
    }
    Ok(message)
}
pub(crate) fn decode_subscription(body: &[u8], capabilities: &Capabilities) -> Result<Request> {
    let mut r = Reader { bytes: body, at: 0 };
    let id = r.u32()?;
    let group = r.u32()?;
    let channel = r.u8()?;
    let timing = r.timing()?;
    let sequence_number_format = SequenceNumberFormat::from_tag(r.u8()?)?;
    let n = r.count(4)?;
    let mut bundles = Vec::with_capacity(n);
    for _ in 0..n {
        let n = r.count(5)?;
        let mut bindings = Vec::with_capacity(n);
        for _ in 0..n {
            let descriptor = r.u32()?;
            let kind = capabilities
                .descriptors
                .get(descriptor as usize)
                .ok_or("Unknown descriptor in binding layout")?
                .kind;
            bindings.push(SampleBinding {
                descriptor,
                format: r.u8()?,
                space: if kind == 10 { r.u8()? } else { 0 },
            });
        }
        bundles.push(bindings);
    }
    if r.at != body.len() {
        return Err("Trailing subscription bytes".into());
    }
    let request = Request {
        id,
        group,
        channel,
        interval: timing.interval,
        phase: timing.phase,
        prediction_offset: timing.prediction_offset,
        sequence_number_format,
        bundles,
    };
    request.validate_structure(capabilities)?;
    Ok(request)
}
pub fn decode_acknowledgment(bytes: &[u8], format: SequenceNumberFormat) -> Result<(u32, u64)> {
    let mut r = Reader { bytes, at: 0 };
    if r.u8()? != 13 {
        return Err("Not a publication acknowledgment".into());
    }
    let id = r.u32()?;
    let mut sequence = [0; 8];
    sequence[..format.width()].copy_from_slice(r.take(format.width())?);
    if r.at != bytes.len() {
        return Err("Trailing acknowledgment bytes".into());
    }
    Ok((id, u64::from_le_bytes(sequence)))
}
fn u32_bytes(b: &mut Vec<u8>, n: u32) {
    b.extend(n.to_le_bytes());
}
fn string(b: &mut Vec<u8>, s: &str) {
    u32_bytes(b, s.len() as u32);
    b.extend(s.as_bytes());
}
fn timing_bytes(b: &mut Vec<u8>, timing: Timing) {
    for value in [timing.interval, timing.phase, timing.prediction_offset] {
        b.extend(value.to_le_bytes());
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
    let mut b = Vec::new();
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
            b.push(r.channel);
            timing_bytes(&mut b, r.timing());
            b.push(r.sequence_number_format.map_or(0, |f| f as u8));
            u32_bytes(&mut b, r.bundles.len() as u32);
            for bundle in &r.bundles {
                u32_bytes(&mut b, bundle.len() as u32);
                for binding in bundle {
                    u32_bytes(&mut b, binding.descriptor);
                    b.push(binding.format);
                    if binding.space != 0 {
                        b.push(binding.space);
                    }
                }
            }
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
        Message::UpdateSchedule { id, timing } => {
            b.push(12);
            u32_bytes(&mut b, *id);
            timing_bytes(&mut b, *timing);
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
    b
}

#[derive(Clone, Debug)]
pub struct Subscription {
    pub request: Request,
    pub publication: std::sync::Arc<std::sync::Mutex<PublicationState>>,
}
impl Subscription {
    fn new(request: Request, now: u64) -> Self {
        Self {
            publication: std::sync::Arc::new(std::sync::Mutex::new(PublicationState::new(
                &request, now,
            ))),
            request,
        }
    }
}

pub struct Session {
    pub capabilities: Arc<Capabilities>,
    pub negotiated: bool,
    pub packet_limit: usize,
    pub max_publication_rate_hz: f64,
    pub active: BTreeMap<u32, Subscription>,
}
impl Session {
    pub fn new(capabilities: impl Into<Arc<Capabilities>>) -> Self {
        Self {
            capabilities: capabilities.into(),
            negotiated: false,
            packet_limit: MAX_SERVER_MESSAGE,
            max_publication_rate_hz: 200.,
            active: BTreeMap::new(),
        }
    }
    pub fn handle(&mut self, message: Message, now: i64) -> Result<Vec<Message>> {
        self.handle_with_source(message, now, |_| Ok(()))
    }
    /// Apply protocol validation and admission once, then check the selected source
    /// before atomically installing a new subscription. A source failure is a rejection.
    pub fn handle_with_source(
        &mut self,
        message: Message,
        now: i64,
        mut source: impl FnMut(&Request) -> Result<()>,
    ) -> Result<Vec<Message>> {
        if !self.negotiated {
            if let Message::Offer(v) = message {
                validate_offer(&v)?;
                if !v.contains(&1) {
                    return Ok(vec![Message::Selection(0)]);
                }
                self.capabilities.validate()?;
                if encode(&Message::Capabilities(self.capabilities.clone())).len()
                    > self.packet_limit
                {
                    return Err("Capabilities exceed transport limit".into());
                }
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
                request.validate_structure(&self.capabilities)?;
                let id = request.id;
                let validation = self.capabilities.admit_request(&request).and_then(|size| {
                    self.admit(request.timing(), now as u64)?;
                    if size + 1 > self.packet_limit {
                        return Err("Publication exceeds negotiated transport limit".into());
                    }
                    if self.active.len() >= MAX_SUBSCRIPTIONS && !self.active.contains_key(&id) {
                        return Err("Subscription limit".into());
                    }
                    source(&request)
                });
                if let Err(reason) = validation {
                    return Ok(vec![Message::Rejected {
                        id,
                        reason: Some(reason),
                    }]);
                }
                self.active
                    .insert(id, Subscription::new(request, now as u64));
                Ok(vec![Message::Accepted { id }])
            }
            Message::Unsubscribe { id } => {
                self.active.remove(&id);
                Ok(vec![Message::Ended {
                    id,
                    reason: "Unsubscribed".into(),
                }])
            }
            Message::UpdateSchedule { id, timing } => {
                timing.validate()?;
                if !self.active.contains_key(&id) {
                    return Ok(vec![]);
                }
                if let Err(reason) = self.admit(timing, now as u64) {
                    return Ok(self.end(id, &reason));
                }
                let sub = self.active.get_mut(&id).unwrap();
                sub.request.interval = timing.interval;
                sub.request.phase = timing.phase;
                sub.request.prediction_offset = timing.prediction_offset;
                sub.publication.lock().unwrap().update(timing, now as u64);
                Ok(vec![])
            }
            _ => Err("Message in invalid session phase".into()),
        }
    }
    fn admit(&self, timing: Timing, now: u64) -> Result<()> {
        timing
            .next_at(now)
            .and_then(|slot| timing.target_at(slot))
            .filter(|t| *t <= i64::MAX as u64)
            .ok_or("Prediction target exceeds source clock range")?;
        if (timing.interval as f64) < (1e9 / self.max_publication_rate_hz).ceil() {
            return Err("Publication rate admission limit".into());
        }
        Ok(())
    }
    pub fn acknowledge(&self, bytes: &[u8]) {
        if !self.negotiated || bytes.len() < 5 {
            return;
        }
        let id = u32::from_le_bytes(bytes[1..5].try_into().unwrap());
        if let Some(sub) = self.active.get(&id)
            && let Some(format) = sub.request.sequence_number_format
            && let Ok((_, sequence)) = decode_acknowledgment(bytes, format)
        {
            sub.publication.lock().unwrap().acknowledge(sequence);
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

/// One latest encoded acquisition and bounded metadata; no historical source snapshots.
#[derive(Clone, Debug)]
pub struct EncodedAcquisition {
    pub number: u64,
    pub acquired_at: u64,
    pub predicted_for: Option<u64>,
    pub bundles: Vec<Vec<u8>>,
}
#[derive(Clone, Debug)]
struct BundleState {
    revision: u64,
    pending: bool,
}
#[derive(Clone, Debug)]
struct SentPublication {
    sequence: u64,
    revisions: Vec<(usize, u64)>,
}
#[derive(Clone, Debug)]
pub struct Candidate {
    pub body: Vec<u8>,
    pub sequence: Option<u64>,
    revisions: Vec<(usize, u64)>,
}
pub const SENT_HISTORY_LIMIT: usize = 256;
#[derive(Debug)]
pub struct PublicationState {
    id: u32,
    timing: Timing,
    format: Option<SequenceNumberFormat>,
    continuous_empty: bool,
    initial: bool,
    next_slot: Option<u64>,
    next_sequence: u64,
    states: Vec<BundleState>,
    latest: Option<EncodedAcquisition>,
    available: bool,
    history: VecDeque<SentPublication>,
    history_limit: usize,
    pub error: Option<String>,
}
impl PublicationState {
    pub fn new(r: &Request, now: u64) -> Self {
        Self {
            id: r.id,
            timing: r.timing(),
            format: r.sequence_number_format,
            continuous_empty: r.bundles[0].is_empty(),
            initial: true,
            next_slot: r.timing().next_at(now),
            next_sequence: 0,
            states: r
                .bundles
                .iter()
                .map(|_| BundleState {
                    revision: 0,
                    pending: true,
                })
                .collect(),
            latest: None,
            available: false,
            history: VecDeque::new(),
            history_limit: SENT_HISTORY_LIMIT,
            error: None,
        }
    }
    pub fn observe(&mut self, acquisition: EncodedAcquisition) {
        if self.error.is_some()
            || self
                .latest
                .as_ref()
                .is_some_and(|last| last.number >= acquisition.number)
        {
            return;
        }
        for (i, state) in self.states.iter_mut().enumerate().skip(1) {
            if self
                .latest
                .as_ref()
                .is_none_or(|last| last.bundles[i] != acquisition.bundles[i])
            {
                // Expiring history before a local revision wraps prevents ABA aliasing.
                if state.revision == u64::MAX {
                    self.history.clear();
                }
                state.revision = state.revision.wrapping_add(1);
                state.pending = true;
            }
        }
        self.latest = Some(acquisition);
        self.available = true;
    }
    pub fn invalidate_acquisition(&mut self) {
        self.available = false;
    }
    pub fn update(&mut self, timing: Timing, now: u64) {
        self.timing = timing;
        self.next_slot = timing.next_at(now);
    }
    pub fn next_wake(&self) -> Option<u64> {
        if self.initial {
            self.available.then_some(0)
        } else {
            self.next_slot
        }
    }
    pub fn requested_target(&self, now: u64) -> Option<u64> {
        let opportunity = if self.initial {
            now
        } else {
            self.timing.next_at(now)?
        };
        self.timing.target_at(opportunity)
    }
    /// Consume a due opportunity even if empty or backpressured; never queue catch-up work.
    pub fn opportunity(&mut self, now: u64) -> bool {
        if self.initial {
            if !self.available {
                return false;
            }
            self.initial = false;
            self.next_slot = now.checked_add(1).and_then(|t| self.timing.next_at(t));
            return self.timing.target_at(now).is_some();
        }
        let Some(due) = self.next_slot.filter(|due| *due <= now) else {
            return false;
        };
        let slot = due + (now - due) / self.timing.interval * self.timing.interval;
        self.next_slot = slot
            .checked_add(self.timing.interval)
            .filter(|t| *t < u64::MAX);
        self.timing.target_at(slot).is_some()
    }
    pub fn candidate(&self) -> Option<Candidate> {
        let latest = self.latest.as_ref()?;
        if !self.available
            || self.error.is_some()
            || (self.continuous_empty && !self.states.iter().skip(1).any(|s| s.pending))
        {
            return None;
        }
        let mut revisions = Vec::new();
        let bundles: Vec<_> = latest
            .bundles
            .iter()
            .enumerate()
            .map(|(i, bytes)| {
                if i == 0 || self.states[i].pending {
                    if i > 0 {
                        revisions.push((i, self.states[i].revision));
                    }
                    Some(bytes.as_slice())
                } else {
                    None
                }
            })
            .collect();
        let sequence = self.format.map(|_| self.next_sequence);
        Some(Candidate {
            body: publication_body(
                self.id,
                latest.acquired_at,
                latest.predicted_for,
                self.format,
                sequence,
                &bundles,
            )
            .expect("Validated acquisition"),
            sequence,
            revisions,
        })
    }
    /// Call only after successful transport submission, including if acquisition changed during send.
    pub fn submitted(&mut self, candidate: Candidate) {
        let Some(format) = self.format else {
            return;
        };
        let sequence = candidate.sequence.expect("Sequenced candidate");
        debug_assert_eq!(sequence, self.next_sequence);
        self.next_sequence = format.next(sequence);
        self.history
            .retain(|entry| sequence.wrapping_sub(entry.sequence) & format.mask() < format.half());
        if !candidate.revisions.is_empty() {
            self.history.push_back(SentPublication {
                sequence,
                revisions: candidate.revisions,
            });
        }
        while self.history.len() > self.history_limit
            || self
                .history
                .iter()
                .map(|e| e.revisions.len())
                .sum::<usize>()
                > 4096
        {
            self.history.pop_front();
        }
    }
    pub fn acknowledge(&mut self, sequence: u64) {
        let Some(index) = self
            .history
            .iter()
            .position(|entry| entry.sequence == sequence)
        else {
            return;
        };
        let sent = self.history.remove(index).unwrap();
        for (i, revision) in sent.revisions {
            if self.states[i].revision == revision {
                self.states[i].pending = false;
            }
        }
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
fn encode_value_into(value: &Value, kind: u8, format: u8, b: &mut Vec<u8>) -> Option<()> {
    if !compatible(kind, format) {
        return None;
    }
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
            if !valid_numbers(kind, format, values) {
                return None;
            }
            let mut converted = [0.; 7];
            for (out, value) in converted.iter_mut().zip(values) {
                *out = if format == 10 {
                    (*value as f32) as f64
                } else {
                    *value
                };
            }
            let converted = &converted[..values.len()];
            if !valid_numbers(kind, format, converted) {
                return None;
            }
            for &v in converted {
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
    Some(())
}
pub fn encode_bundle(
    c: &Capabilities,
    bindings: &[SampleBinding],
    values: &[Value],
) -> Result<Vec<u8>> {
    if bindings.len() != values.len() {
        return Err("Incomplete bundle".into());
    }
    let bits = bindings.iter().filter(|s| s.format == 1).count();
    let mut buffer = vec![0; bits.div_ceil(8)];
    let mut bit = 0;
    for (binding, value) in bindings.iter().zip(values) {
        let descriptor = c
            .descriptors
            .get(binding.descriptor as usize)
            .ok_or("Unknown publication descriptor")?;
        if binding.format == 1 {
            let Value::Bit(value) = value else {
                return Err("Invalid boolean value".into());
            };
            if !compatible(descriptor.kind, 1) {
                return Err("Invalid boolean format".into());
            }
            buffer[bit / 8] |= u8::from(*value) << (bit % 8);
            bit += 1;
        } else {
            encode_value_into(value, descriptor.kind, binding.format, &mut buffer).ok_or_else(
                || format!("Invalid value for selected source {}", binding.descriptor),
            )?;
        }
    }
    Ok(buffer)
}
pub fn publication_body(
    id: u32,
    acquired_at: u64,
    predicted_for: Option<u64>,
    format: Option<SequenceNumberFormat>,
    sequence: Option<u64>,
    bundles: &[Option<&[u8]>],
) -> Result<Vec<u8>> {
    if acquired_at == u64::MAX
        || predicted_for == Some(u64::MAX)
        || bundles.is_empty()
        || bundles[0].is_none()
        || format.is_some() != sequence.is_some()
        || (bundles.len() > 1 && format.is_none())
    {
        return Err("Invalid publication layout or timestamps".into());
    }
    let mut body = Vec::new();
    body.extend(id.to_le_bytes());
    body.extend(acquired_at.to_le_bytes());
    body.extend(predicted_for.unwrap_or(u64::MAX).to_le_bytes());
    if let Some(format) = format {
        let sequence = sequence.unwrap();
        if sequence > format.mask() {
            return Err("Sequence exceeds selected width".into());
        }
        body.extend(&sequence.to_le_bytes()[..format.width()]);
    }
    let presence_at = body.len();
    body.resize(presence_at + (bundles.len() - 1).div_ceil(8), 0);
    for (i, bundle) in bundles.iter().enumerate() {
        if let Some(bytes) = bundle {
            if i > 0 {
                body[presence_at + (i - 1) / 8] |= 1 << ((i - 1) % 8);
            }
            body.extend(*bytes);
        }
    }
    Ok(body)
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
