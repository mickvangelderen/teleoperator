# XR tracking binary protocol, version 3

Status: proposed specification, derived from [PRO-0001 through PRO-0014](../design/requirements/protocol/README.md)
at commit `4fdba6d`. The requirements are authoritative. This document supplies
wire-level choices where they leave room; those choices are identified in the
[requirements review](#requirements-review). MUST, MUST NOT, and SHOULD describe
conformance to this draft, not additional hand-written requirements.

The protocol has reliable, ordered control messages and unordered tracking
messages with zero retransmissions. A subscription selects values from exactly
one acquisition group. The accepted selection determines a compact snapshot
layout at runtime; no generated device-specific schema is needed.

## Transport and connection

The transport MUST provide two associated, message-oriented channels:

| Channel | Classification | Delivery | Contents |
| --- | --- | --- | --- |
| Control | Reliability critical | Reliable, ordered, both directions | Negotiation, capabilities, requests, responses, interpretation metadata, termination |
| Tracking | Latency critical | Unordered, zero retries, server to client | Complete selected snapshots |

One transport message contains exactly one protocol message. There is no outer
length, checksum, compression envelope, alignment padding, or concatenation.
The transport preserves message boundaries and detects corrupted delivery.
Fragmentation and reassembly, if needed, belong to that transport. A stream
transport needs a separate framing binding; raw TCP is not this binding.

Both channels form one connection. Losing either terminates the connection and
all subscriptions. Authentication, transport establishment, signaling, and
channel naming are outside this specification. A transport binding MUST identify
this custom binary protocol separately from the retired FlatBuffers protocol.

There is no ordering between the channels. Enqueuing an acceptance on control
before a snapshot does not ensure it arrives first. Tracking never waits for an
acknowledgement, missing packet, or retransmission. A receiver discards snapshots
whose accepted layout is not yet known, then uses subsequent fresh snapshots.

All wire identities and interpretation state are connection-local, except the
device-stable descriptor and reference-space strings. Reconnection repeats the
entire handshake and discovery, even to the same server. Discard pending requests,
layouts, ordering baselines, and callbacks from the previous connection. No
server-instance ID or version is repeated in tracking packets.

## Wire conventions

Fields appear in the order written. Records have no implicit padding. Types are:

| Notation | Encoding |
| --- | --- |
| `u8` | One unsigned byte |
| `uvar` | Canonical unsigned base-128 integer, range 0 through 2^64 - 1 |
| `i64` | Eight little-endian bytes, two's complement |
| `f32` | Four little-endian bytes, IEEE 754 binary32 |
| `text` | `uvar` UTF-8 byte length, then exactly those bytes, without a terminator |
| `bytes` | `uvar` byte length, then exactly those bytes |
| `list<T>` | `uvar` element count, then that many consecutive encodings of `T` |

For `uvar`, the low seven bits of each byte contribute successive groups of
seven bits, least significant group first. Bit 7 means another byte follows.
Use the shortest representation. Zero is `00`, 127 is `7f`, and 128 is `80 01`.
At most ten bytes are allowed; the tenth byte, when present, MUST be `01`.
Truncated, overlong, and overflowing encodings are invalid. IDs and counters
must retain all 64 bits; a floating-point number is not an adequate storage type.

Text MUST be valid UTF-8. Identifiers are nonempty, case-sensitive, and compared
by bytes without Unicode normalization. Names and descriptions may be empty
unless a more specific rule below requires content. No field is optional unless
an explicit condition says so. Zero lengths and numeric zero are values, not
missing-field markers. Rates are finite positive `f32` values. All integers used
as counts or offsets must be checked before host-size conversion or multiplication.

The hard maximum message size on either channel is 65,536 bytes, including the
message tag where present. Capabilities can set a smaller tracking limit. A
transport binding MUST support the control maximum and the advertised tracking
limit. There is no application-level splitting of capability messages or
snapshots in this version. An oversized catalog cannot be advertised in v3.

### Optional extensions

```text
Extension {
    name: text
    payload: bytes
}
```

Extension names are nonempty and MUST be unique within their enclosing list.
Authors SHOULD use namespaced names, for example `org.example.device.quality`.
An extension's own specification defines its opaque payload. Unknown extensions
are skipped using their byte length. They MUST NOT change core field meanings,
sample widths, validity, coordinates, or decoding. If an unknown extension would
make the core data unsafe to interpret, that feature needs a new negotiated
version instead.

## Version negotiation

Control messages begin with a `u8` tag. The following bootstrap layouts remain
fixed across future versions of this custom protocol family:

```text
0x01 ClientHello {
    magic: u8[4]                 // 58 52 50 42, ASCII "XRPB"
    supported_versions: list<uvar>
}

0x02 ServerHello {
    magic: u8[4]                 // same magic
    supported_versions: list<uvar>
    selected_version: uvar
    reason: text
}
```

Each version list contains 1 through 32 distinct nonzero numbers. A v3-only peer
advertises `[3]`. The client sends ClientHello as its first control message.
The server responds exactly once, selecting a member of both lists. Selection
policy among multiple common versions is the server's choice. Success uses an
empty reason; rejection uses selected version zero and a nonempty reason, after
which the server closes after allowing delivery of the rejection. An invalid
magic or malformed hello is a connection error, not version negotiation.

No other client message is sent before successful ServerHello; the server sends
Capabilities next. The client waits for Capabilities before subscription requests.
Neither peer sends tracking before successful negotiation. A repeated hello is a
protocol error. The selected version applies to both channels until disconnection
and cannot change in place. All other message layouts below apply only after
selecting version 3. Neither channel carries per-message protocol versions after
the bootstrap.

## Capability advertising

```text
0x03 Capabilities {              // server -> client
    catalog_id: uvar
    max_subscriptions: uvar
    max_tracking_bytes: uvar
    spaces: list<ReferenceSpace>
    groups: list<SampleGroup>
    samples: list<SampleDescriptor>
    extensions: list<Extension>
}

ReferenceSpace {
    id: text
    revision: uvar
    name: text
    description: text
}

SampleGroup {
    max_sample_rate_hz: f32
    min_publication_rate_hz: f32
    max_publication_rate_hz: f32
    default_publication_rate_hz: f32
}

SampleDescriptor {
    id: text
    name: text
    description: text
    kind: u8
    supported_formats: list<u8>
    group: uvar
    space: uvar                 // present ONLY when kind == pose (0x0A)
    extensions: list<Extension>
}
```

`catalog_id` starts at one and strictly increases with every complete capability
snapshot. It never wraps. Sample, group, and space indices are zero-based offsets
in the corresponding lists of that catalog. Every descriptor refers to an
existing group; every pose refers to an existing space. Empty catalogs and groups
without descriptors are allowed. `max_subscriptions` is positive;
`max_tracking_bytes` is between 1 and 65,536 inclusive and bounds complete tracking
messages, not just their value bytes.

For each group:

```text
0 < min_publication_rate_hz <= default_publication_rate_hz
  <= max_publication_rate_hz <= max_sample_rate_hz
```

Every finite `f32` rate within the advertised publication interval is requestable.
The maximum acquisition frequency is a ceiling, not a promise of regular sampling
or fresh data at that rate. The server chooses acquisition scheduling, resource
allocation, and how to share physical acquisition across clients. This version
does not request acquisition rates. A group may contain different semantic kinds;
controller, pose, and body categories do not impose separate groups.

Descriptor IDs MUST be unique within a catalog and stable for the same semantic
source on a device across connections. Use an OpenXR interaction profile component
path where applicable; derived values such as a control's press count need their
own distinct IDs. Do not identify controls by translated display names. Neither
ID syntax nor list position defines a relationship between different descriptors.

Supported formats are a nonempty list of distinct known formats permitted by the
kind. Support does not imply current availability. A body joint is an individually
addressable `pose` descriptor, so clients can select joints without subscribing to
the whole body. Body topology, rest poses, and device-specific properties can be
described by optional extensions; this draft does not standardize those payloads.

### Reference spaces and catalog changes

Space IDs are unique within a catalog and stable on a device. Their nonzero
revisions identify immutable coordinate-frame meanings within this connection.
All poses naming the same `(space id, revision)` share that frame, including
across groups and catalogs. The nonempty description MUST explain the frame's
origin and anchoring well enough to use it, for example a floor-relative tracking
origin. There are no fixed numeric IDs for a particular device's spaces.

A new catalog replaces discovery, but MUST NOT mutate existing subscriptions or
their interpretation. Clients retain the referenced catalog information for every
active subscription. A request naming an older catalog is rejected as stale;
accepted subscriptions may continue referring to older catalogs. Their original
tracking-byte limit continues to apply. New subscription-count limits govern
admission; if active subscriptions must be removed, terminate them explicitly.

If a source, layout, counter continuity, or required interpretation can no longer
be maintained, stop producing affected snapshots and terminate those subscriptions
over control. If capabilities change, advertise the new catalog before sending
the associated termination notifications, so the client can select a replacement.
Temporary unavailable values use the validity bitmap instead of a catalog change.

Recenter or redefinition of a space requires a strictly higher space revision,
a new catalog, and termination of subscriptions using the old frame. Never encode
new-frame values under an old acceptance. Queued old-frame packets retain their
old interpretation and are discarded after termination. No continuity transform
is implied. A client may resubscribe under the same subscription ID, obtaining a
new acceptance revision. This uses the normal replacement lifecycle instead of
adding per-pose metadata versions to every snapshot.

## Sample formats

These codes and permitted combinations reproduce PRO-0010 and PRO-0011. All
components of a multi-component kind use the single selected format.

| Code | Format | Bits per component | Interpretation |
| --- | --- | ---: | --- |
| `00` | invalid | — | Never allowed |
| `01` | bit | 1 | 0 = false, 1 = true |
| `02` | u8 | 8 | Unsigned integer |
| `03` | u16 | 16 | Unsigned integer |
| `04` | u32 | 32 | Unsigned integer |
| `05` | u64 | 64 | Unsigned integer |
| `06` | i8 | 8 | Two's-complement integer |
| `07` | i16 | 16 | Two's-complement integer |
| `08` | i32 | 32 | Two's-complement integer |
| `09` | i64 | 64 | Two's-complement integer |
| `0A` | f32 | 32 | IEEE 754 binary32 |
| `0B` | f64 | 64 | IEEE 754 binary64 |
| `0C` | unorm8 | 8 | `raw / 255` |
| `0D` | unorm16 | 16 | `raw / 65535` |
| `0E` | snorm8 | 8 | `max(-1, signed_raw / 127)` |
| `0F` | snorm16 | 16 | `max(-1, signed_raw / 32767)` |

Codes `10` through `FF` are reserved. For normalized encoding, clamp the source
value to the semantic interval, multiply by the positive denominator, and round
to nearest integer with ties to even. Thus canonical encoders use -127/-32767
for -1, while decoders also accept -128/-32768 as -1. Non-finite source values
are unavailable, never converted to a normalized endpoint.

| Code | Kind | Components | Permitted formats |
| --- | --- | ---: | --- |
| `00` | invalid | — | None |
| `01` | generic | 1 | Any defined, valid format |
| `02` | pressed | 1 | bit |
| `03` | press_count | 1 | u8, u16, u32, u64 |
| `04` | release_count | 1 | u8, u16, u32, u64 |
| `05` | touched | 1 | bit |
| `06` | touch_count | 1 | u8, u16, u32, u64 |
| `07` | untouch_count | 1 | u8, u16, u32, u64 |
| `08` | trigger | 1 | unorm8, unorm16, f32, f64 |
| `09` | thumbstick | 2 | snorm8, snorm16, f32, f64 |
| `0A` | pose | 7 | f32, f64 |

Kind codes `0B` through `FF` are reserved. `generic` is one scalar with
application-defined meaning; it does not imply units, ranges, or a custom component
count. Describe its meaning in the descriptor or an optional extension.

Trigger values are in [0, 1], released to fully pressed. Thumbsticks are `(x, y)`
in [-1, 1] per axis, with positive X right and positive Y up. Pose components are
`(position.x, position.y, position.z, orientation.x, orientation.y, orientation.z,
orientation.w)`. Positions are metres in the descriptor's reference space. The
frame is right-handed, +X right, +Y up, -Z forward. Quaternions rotate local
coordinates into that reference space; joint poses are not implicitly
parent-relative. Valid floating components MUST be finite; valid floating trigger
and thumbstick components MUST be within their semantic ranges. Valid quaternions
MUST satisfy `abs(x*x + y*y + z*z + w*w - 1) <= 0.0001`. Receivers do not silently
normalize malformed data. Both quaternion signs are valid.

## Subscription lifecycle

All subsequent control messages have the following complete layouts. Tags `09`
through `FF` are reserved; `00` is invalid. Directions are normative.

```text
Selection {
    sample: uvar                // descriptor index in the named catalog
    format: u8
}

0x04 Subscribe {                // client -> server; creates OR replaces
    request_id: uvar
    subscription_id: uvar
    catalog_id: uvar
    group: uvar
    publication_rate_hz: f32
    selections: list<Selection>
}

0x05 SubscriptionAccepted {     // server -> client
    request_id: uvar
    subscription_id: uvar
    catalog_id: uvar
    group: uvar
    publication_rate_hz: f32
    selections: list<Selection>
}

0x06 RequestRejected {          // server -> client
    request_id: uvar
    subscription_id: uvar
    code: u8
    detail: text
}

0x07 Unsubscribe {              // client -> server
    request_id: uvar
    subscription_id: uvar
}

0x08 SubscriptionEnded {        // server -> client
    request_id: uvar            // zero for server-initiated termination
    subscription_id: uvar
    revision: uvar              // accepted Subscribe request_id; see below
    reason: u8
    detail: text
}
```

The client assigns subscription IDs according to its own policy; any `uvar`,
including zero, is valid. IDs need only distinguish concurrently active
subscriptions on this connection. They may be reused after termination.

The client also assigns strictly increasing, nonzero `request_id` values to all
Subscribe and Unsubscribe requests, in control send order. These IDs correlate
responses; they do not constrain the client's subscription-ID policy. They never
wrap or get reused on a connection. The accepted Subscribe's `request_id` becomes
that subscription's **revision**, carried in tracking messages to distinguish
old packets after replacement or ID reuse. It is not a protocol version.

The server processes requests and enqueues their responses in receive order.
Every syntactically valid request receives exactly one result: acceptance or
rejection for Subscribe, and SubscriptionEnded for Unsubscribe. Responses must
match an outstanding request, including its subscription ID. A client may have
multiple requests pending, including for the same subscription ID.

### Creating and replacing

All selections MUST name distinct existing descriptors in the chosen group and
select one of each descriptor's supported formats. The selection list is nonempty;
its order is the client's chosen packing order. Selecting data from zero groups
means having no subscriptions, not creating an empty one. Different groups need
different subscriptions. There are no implied selections: press state does not
automatically include counters, and one body joint does not select its relatives.

The rate is explicit. Clients can copy the advertised default; absent fields,
zero, NaN, and infinity do not mean “use the default.” The server either accepts
the exact requested settings or rejects them, without rounding or substituting
formats. No separate publication-update message exists.

Before acceptance, validate the catalog, group, selections, formats, rate,
subscription count, resource availability, and worst-case tracking-message size.
A replacement consumes one active slot, not two. Its maximum encoded size is
`len(uvar(subscription_id)) + len(uvar(request_id)) + 10 + 8 + snapshot_bytes`;
the ten bytes reserve the full acquisition-sequence range. Reject a layout that
cannot fit the advertised tracking limit even if today's sequence would fit.

SubscriptionAccepted repeats the exact request settings. Together with its
already-received catalog, it supplies the complete immutable interpretation and
layout. No tracking bytes may contain metadata the acceptance does not identify.

An accepted request replaces the old subscription with that ID atomically at the
server. Stop publishing its old revision, enqueue acceptance over control, then
immediately begin publication for the new revision without a client acknowledgement.
Do not send a separate SubscriptionEnded for the replaced revision. On rejection,
leave the previous accepted subscription untouched.

The client continues using its old acceptance while a replacement is pending.
It switches atomically upon receiving the new acceptance, resetting per-revision
ordering and edge baselines. Already queued old packets may still arrive and
MUST be discarded. New packets that arrive before acceptance are also discarded,
not decoded using the old layout, even if their byte lengths happen to match.

### Unsubscription and rejection

Unsubscribe applies to the active revision when the server processes the request.
Stop new publications and return SubscriptionEnded with that revision and reason
`00`. If no subscription is active, return revision zero and reason `01` instead;
unsubscription is idempotent. The client may discard data immediately on a local
unsubscribe, but must still process the corresponding response.

The server may terminate a subscription for any reason. It stops new publications
and sends SubscriptionEnded with request ID zero, the active nonzero revision,
and an explanation. A termination removes only the matching revision; delayed
tracking cannot recreate it. All terminations have nonempty explanatory text.

| Rejection code | Meaning |
| --- | --- |
| `01` | Stale or unknown catalog |
| `02` | Invalid selection: empty, duplicate, unknown, or mixed groups |
| `03` | Unsupported or unknown selected format |
| `04` | Invalid or unsupported publication rate |
| `05` | Subscription or other resource limit |
| `06` | Tracking message would exceed the advertised byte limit |
| `07` | Data unavailable or permission denied |
| `08` | Other refusal |

Rejection detail is nonempty and explains the failed request. Invalid settings
that can be decoded safely receive a rejection, including unknown indices,
unknown selection format bytes, and non-finite requested rates. The subscription
stays unchanged. Malformed framing or reused request IDs are connection errors.

| End reason | Meaning |
| --- | --- |
| `00` | Client unsubscribed; request ID and revision are nonzero |
| `01` | Already absent; request ID is nonzero and revision is zero |
| `02` | Capability unavailable |
| `03` | Resource reclaimed |
| `04` | Server stopping |
| `05` | Interpretation or source continuity changed |
| `06` | Other server termination |

Reasons `02` through `06` have request ID zero and a nonzero revision. Other
rejection/end codes are reserved. On disconnect, subscriptions end implicitly;
there need not be a final control notification.

## Packed snapshots

The tracking channel carries only this message, so it needs no message-type tag:

```text
Snapshot {
    subscription_id: uvar
    revision: uvar
    acquisition_sequence: uvar
    acquired_at_ns: i64
    packed_values: u8[snapshot_bytes]
}
```

The subscription and revision identify the exact accepted layout. Group and
catalog are recovered from that acceptance and are not repeated. The sequence
is nonzero and identifies one acquisition of that group in that catalog. It
increases at every acquisition, including acquisitions not published to this
client, and does not wrap. Subscriptions referring to the same catalog and group
share the sequence and acquisition timestamp for a given acquisition. Sequences
from different groups or catalogs are not comparable.

`acquired_at_ns` is the application's acquisition timestamp, in signed integer
nanoseconds from one opaque monotonic server epoch for this connection, shared
across groups. Timestamps never decrease within a group's sequence; equal times
are permitted. They are not UTC, client time, prediction target time, or a promise
of nanosecond accuracy. Values in a snapshot come from one group acquisition;
the server cannot silently combine acquisitions of different groups.

### Layout derivation

Let `N` be the number of selections. For selection `i`, let `C[i]` be its kind's
component count, `W[i]` its selected format's width in bits, and
`V[i] = C[i] * W[i]`.

```text
validity bit for selection i = i
first value bit for selection i = N + sum(V[j] for j < i)
component k of selection i starts at that bit + k * W[i]
snapshot_bits = N + sum(V[i])
snapshot_bytes = (snapshot_bits + 7) // 8
```

Bit zero is the least significant bit of the first byte of `packed_values`.
Bit `b` is `(packed_values[b // 8] >> (b % 8)) & 1`. For each component, store its
raw integer bit pattern least significant bit first, starting at its assigned
bit offset. Signed values use their two's-complement pattern; floats use their
IEEE bit pattern. Components may cross byte boundaries. There is no alignment
between the validity bitmap, selections, or components. Only unused high bits
of the final byte are padding, and they MUST be zero.

This determines a fixed layout for each acceptance, even when availability
changes. There are no per-value type tags, IDs, lengths, presence bytes, or
host-struct padding. Fields that happen to start at a byte boundary have ordinary
little-endian representation. Implementations must not assume aligned memory.

A validity bit of one means the entire selected value is present and usable
according to its semantic kind. Zero means missing, inactive, or otherwise
unusable. All component bits in an invalid value MUST be zero and MUST NOT be
interpreted as a valid zero, release, identity pose, or instruction to reuse a
previous value. A valid false button and an unavailable button are distinct.
This version does not distinguish the reasons for invalidity or represent partial
pose validity: if either position or orientation is unusable, the whole pose is
invalid. That limitation is a review question below.

Each snapshot is absolute and independent of previous tracking packets. Even
unchanged selected values occupy their slots. No delta compression, dictionary
state, previous-packet timestamp base, or recovery acknowledgement is allowed.

### Publication and receiving

`publication_rate_hz` is the requested target publication cadence, not a promised
delivery rate or acquisition rate. Publication is eligible immediately upon
acceptance using the newest available acquisition. If none exists, publish when
the first becomes available. Subsequent publications use the newest as-yet-unsent
acquisition at the subscription's cadence. Do not wait for earlier packets or
queue old acquisitions to catch up. If no new acquisition exists, send nothing.
New acquisitions whose values happen to be unchanged are still new acquisitions.

Keep pending publications bounded, replacing obsolete unsent data with fresh
data under congestion. Acquisition frequency, publication cadence, and client
consumption cadence can differ. There is no publication sequence, acquisition
history array, or guarantee that every acquisition will be delivered in v3.

Receive processing is atomic:

1. Check the message limit and parse its subscription ID and revision safely.
2. If that exact acceptance is not active, discard the entire packet.
3. Check the remaining header, exact expected byte length, padding, invalid slots,
   and all valid values before exposing any part of the snapshot.
4. Apply it only if its acquisition sequence is newer than the last applied one
   for this revision and its timestamp has not decreased. Ignore duplicates and
   reordered older snapshots. A rejected packet never advances either baseline.

Duplicate copies of one acquisition for one revision must have identical content.
Client applications choose their own staleness thresholds and must not infer a
release from inactivity or a missing packet. Sequence gaps indicate absent
acquisitions at this consumer, not necessarily network loss: publication may have
deliberately skipped them. Device sample times and local receive times cannot be
subtracted to measure latency without a clock mapping, which v3 does not supply.

## Edge counters

Press, release, touch, and untouch counts are distinct selectable values. Every
advertised `pressed` source MUST have corresponding `press_count` and
`release_count` descriptors; every `touched` source MUST have `touch_count` and
`untouch_count` descriptors. Their descriptions identify the associated input.
Clients need not select them together. Servers maintain counters independently
of subscriptions and publication. Prefer native device transition information
when available; snapshot-based inference cannot recover
transitions the device never exposed. A counter records observed transitions,
not guaranteed physical events.

`pressed` and `touched` report the source's corresponding Boolean states.
Press/touch counters count false-to-true transitions; release/untouch counters
count true-to-false transitions. When inferring transitions from snapshots, compare
only continuously valid states and rebaseline after inactivity without adding an
edge. Repeated observation of the same native transition must not count it twice.

For a selected unsigned width `w`, publish the cumulative count modulo `2^w`.
Different widths for the same descriptor expose the low bits of the same logical
counter. Counters wrap on overflow. Subscription creation, replacement, removal,
and format changes MUST NOT reset the source counter. Activity loss or restoration
does not itself create an edge. If a cumulative count remains known while the
input is inactive, its counter descriptor can still be valid. If count continuity
is lost, terminate affected subscriptions before publishing a reset counter and
advertise a new catalog so new acceptances establish new baselines.

For successive valid observations, a receiver computes
`delta = (new - old) mod 2^w`. This is the true number of observed edges only if
fewer than `2^w` increments occurred between those observations. Multiple wraps
are fundamentally ambiguous; choose a wider advertised format when needed.
Initial reception, reconnection, and replacement establish baselines and MUST NOT
replay the initial cumulative count as new actions. Invalid observations do not
overwrite the last valid count. Only newer accepted acquisitions update it.

Counters do not establish exact transition timestamps, press/release interleaving,
or the ordering of events on different inputs. Related descriptors are not required
to be selected together.

## Validation and evolution

Reject messages beyond the applicable byte limit before decoding their contents.
Check lengths against remaining bytes before allocation, validate UTF-8, bounds,
canonical varints, enums, references, multiplication/addition overflow, and the
precise expected end of the message. Counts never authorize unbounded allocations.
Unknown trailing bytes are an error, not an implicit extension.

Malformed control, invalid capabilities or acceptances, unexpected directions or
message tags, unmatched responses, invalid end/rejection codes, and violated
handshake/request-ID ordering terminate the connection. An acceptance must match
the complete outstanding request. Syntactically decodable but unacceptable
subscription settings receive RequestRejected as described above. Malformed,
unknown-revision, pre-negotiation, and stale tracking is discarded without changing
live state. Malformed traffic can additionally cause transport-level disconnect.

Before a non-wrapping identity, acquisition sequence, or timestamp would overflow,
terminate its affected scope without reusing values: reconnect for request/catalog
IDs, clock exhaustion, or an exhausted space revision; retire affected
subscriptions and advertise a new catalog for an exhausted acquisition sequence.
Edge counters are the explicit wrapping exception.

Reserved core tags, kinds, and formats cannot be deployed as same-version private
extensions. Adding fields to packed records, changing layouts or semantics, or
adding required metadata requires a new negotiated version. Optional extension
payloads may evolve under their own names if ignoring them preserves all core
behavior. The magic and bootstrap layout remain stable so future custom-protocol
peers can reject incompatible versions cleanly. They do not provide compatibility
with any FlatBuffers packet.

## Requirements review

This table traces the draft to the hand-written requirements. It is not a claim
that any implementation or performance requirement has been verified.

| Requirement | Specification coverage |
| --- | --- |
| [PRO-0001](../design/requirements/protocol/PRO-0001.md) | Runtime bit layout, compact IDs, selected formats, no per-value tags. Recorded-data entropy verification remains unperformed. |
| [PRO-0002](../design/requirements/protocol/PRO-0002.md) | Classified channels, independent absolute snapshots, no retries or acknowledgement gate. |
| [PRO-0003](../design/requirements/protocol/PRO-0003.md) | Device-neutral groups, descriptors, formats, spaces, and optional opaque extensions. |
| [PRO-0004](../design/requirements/protocol/PRO-0004.md) | Fixed bootstrap, one negotiated version for both channels for the connection. |
| [PRO-0005](../design/requirements/protocol/PRO-0005.md) | Connection-local state, complete discovery on every connection, no resume protocol. |
| [PRO-0006](../design/requirements/protocol/PRO-0006.md) | Validity bit independent of encoded zero for every selected value. |
| [PRO-0007](../design/requirements/protocol/PRO-0007.md) | Individual selection of inputs, poses, and body joints represented by descriptors. |
| [PRO-0008](../design/requirements/protocol/PRO-0008.md) | Individually selectable cumulative edge counts required for pressed/touched sources. Edge semantics for other input kinds remain a review question. |
| [PRO-0009](../design/requirements/protocol/PRO-0009.md) | Explicit groups; zero or more subscriptions; acquisition scheduling left to the server. Its preliminary position/orientation sketch is superseded here by PRO-0011's pose kind. |
| [PRO-0010](../design/requirements/protocol/PRO-0010.md) | Exact format codes, subscription-independent counters, wrapping behavior. |
| [PRO-0011](../design/requirements/protocol/PRO-0011.md) | Exact kind codes, component counts, format restrictions, and semantics. |
| [PRO-0012](../design/requirements/protocol/PRO-0012.md) | Group maximum sampling rate and shared acquisition timestamp. |
| [PRO-0013](../design/requirements/protocol/PRO-0013.md) | All six required descriptor fields, stable IDs, and indexed groups. |
| [PRO-0014](../design/requirements/protocol/PRO-0014.md) | Discovery then selection, one group per subscription, client IDs, full replacement, explained rejection/termination, immediate publication. |

The operator requirements OP-0001 through OP-0003 repeat PRO-0001 through PRO-0003
and have the same coverage and verification limitations.

### Choices made where requirements leave room

These are explicit review points, not edits to the requirements:

| Topic | Draft choice | Question for requirements |
| --- | --- | --- |
| Packing | Little-endian bit stream; fixed-width value slots even when invalid | Is the CPU cost of unaligned floats acceptable? Would omission of invalid slots matter for realistic data? |
| Efficiency evidence | Analytical sizes and example vectors only | What recordings, entropy estimator, minimum ratio, and bandwidth/precision budget establish success? High entropy alone does not prove useful compression. |
| Publication settings | One explicit rate in an advertised continuous interval; latest single acquisition | Are discrete rates, history redundancy, or batching required? |
| Replacement | Request IDs distinguish accepted incarnations under the same client subscription ID | Must applications preserve edge baselines across a replacement, or is a fresh baseline appropriate? |
| Availability | One usable/unusable bit for the whole selected value | Must inactive, missing, valid-but-untracked, and partial pose validity be distinct? |
| Geometry metadata | Described spaces; recenter closes affected subscriptions | Is seamless recenter handling, a frame transform, or a standardized space-kind enum required? |
| Body metadata | Joints are pose descriptors; no required skeleton hierarchy | Must discovery provide joint relationships, rest poses, calibration, or quality fields in a standard format? |
| Descriptor relationships | Unique IDs but no machine-readable control-to-counter or body-to-joint relationship | How must clients discover which descriptors belong together without parsing device-specific IDs? |
| Counter inventory | Require paired edge counters for pressed/touched sources; infer observed transitions if necessary | Do other input kinds need edge definitions, and what guarantees are needed when native APIs cannot count all transitions? |
| Timing and loss | Group acquisition sequence and timestamp only | Are clock synchronization, prediction/returned-data times, or precise publication-loss statistics required? |
| Catalog evolution | Complete snapshots with immutable referenced interpretation | Must large inventories support pagination, or capabilities change without retiring affected subscriptions? |
| Numeric limits | 64-bit IDs/counters; 65,536-byte messages; fixed quaternion tolerance | What real device limits, error tolerance, and counter-wrap risk should the contract guarantee? |

No historical server defaults, fixed joint counts, global acquisition frequency,
FlatBuffers behaviors, clock-probe exchange, or skeleton schema have been retained
as requirements merely because the previous implementation had them.
