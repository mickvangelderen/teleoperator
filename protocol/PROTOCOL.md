# XR Operator protocol semantics

Version **2** describes the implemented 200 Hz tracker. Version 1 is incompatible;
update operator and Viewer together. The stable hello envelope rejects unsupported
versions before any tracking is interpreted. [README.md](README.md) describes
encoding/generation, [wire.fbs](wire.fbs) defines layouts, and
[TRACKING.md](../operator/TRACKING.md) records historical hardware measurements.

## Transport and lifecycle

The browser opens reliable ordered `control` and unordered zero-retry `tracking`
WebRTC data channels, both with subprotocol `xrop`. HTTP `/offer` exchanges complete
SDP descriptions; see [operator transport](../operator/README.md#transport).

ClientHello is first, with a nonzero request ID and 1–32 unique nonzero supported
versions. ServerHello echoes its ID, advertises [2], and either selects 2 with a
nonzero random 128-bit server session ID or selects 0 with a reason and no session.
No further negotiation is allowed. Drop tracking before acceptance; requesting
streams before hello is rejected. The server then sends Capabilities; subsequent
snapshots replace discovery without modifying accepted stream configurations.

The server supports at most four peers and three streams per peer. Channel labels,
protocol and reliability are checked. Binary packets are bounded to 64 KiB.
Malformed/out-of-state control closes the connection; valid requests with unsupported
settings receive RequestRejected and leave existing streams unchanged. Malformed
tracking is discarded without updating live state. A peer disconnect is terminal
on both implementations, even if WebRTC might otherwise recover; reconnect explicitly.

## Fixed acquisition and selected publication

Acquisition runs at 200 Hz with OpenXR actions prepared at startup. Pose and body
locations target acquisition time in base space 1: Local Floor when supported,
otherwise Local. Capabilities names the actual space kind and reports the read-only acquisition rate. There are no selectable
acquisition rates, prediction policies, velocities, hysteresis or fidelity modes.
Body tracking uses the default 70-joint FB set and runtime default fidelity.
Absent capability tables mean unsupported/unavailable kinds, not fabricated values.

Subscribe always creates a new stream. Select one or more known pose source IDs
or `(source_id, input_id)` pairs, or the advertised body source/joint-set identity.
Reject duplicate, empty or unknown selections. Pose and input selections are sorted
lexicographically by source, then input ID. All selected sources are required;
support does not imply current activity. Inputs remain identified by stable protocol
IDs; labels and runtime joint names are supplementary.

Publication settings are independent per stream: 1–200 Hz and history 1–8. An absent
publication table uses defaults (100 Hz, up to two samples). A supplied table is a complete
replacement: missing rate uses 100 Hz; missing history uses one. Publication
never waits to fill history. UpdatePublication changes only these settings and acknowledges the same stream. Selection changes
require Unsubscribe followed by Subscribe with a new stream ID.

StreamAccepted echoes the request and gives a complete descriptor with matching
selected definitions, publication settings and initial metadata references.
StreamClosed acknowledges unsubscribe, or uses request ID 0 for capability loss.
Loss of body capability closes body streams only. Inactive body tracking with a
valid skeleton can continue producing inactive samples. Discovery may later restore
a lost capability. ServerResumed immediately invalidates the client's clock mapping.

## Identity, counters and history

Session identity changes on server restart and is shared across peers. Stream IDs
are nonzero and never reused in that session. Control request IDs and probe IDs have
separate nonzero namespaces; responses echo them. Neither consumes tracking counters.
Control requests cannot reuse IDs; the current implementation bounds each request
and probe namespace to 65,536 entries.

One complete acquisition tick supplies pose, input and optional body data. Its
session-wide sample number starts at one and the last eight ticks are retained,
even with no subscribers. Every selection and peer sees the same tick numbers and
physical input counters. Streams only filter that history; there are no subscription
identities or retirement messages. Body histories stop at the latest gap in body
availability. A stream's message number increments only on accepted transport sends;
skipped publication consumes no message number. Counters do not wrap.

Every Tracking packet contains a nonempty, complete history of one kind, oldest to
newest, ending at its latest sample. Sample numbers are consecutive within a history,
and acquired_at is nondecreasing. History never exceeds accepted length and retained
contents are immutable. Message numbers distinguish loss/reordering/duplicates;
sample numbers distinguish acquisition gaps and overlapping history. Slow consumers
retain only the latest sample and count replacement separately from network loss.
Old packets never roll live state backwards.

Each Boolean carries cumulative press/release counts, including while inactive.
Increment only for a transition between two active acquisitions. Reacquisition
rebaselines state without inventing a transition; starting/restarting a consumer
baselines counts without replaying historic actions. Scalar values are normalized
[0,1], vector components [-1,1]; active numeric values must be finite.

## Geometry and metadata

Coordinates are right-handed, +X right, +Y up, -Z forward, in meters. Quaternions
use x,y,z,w order and must be finite/unit length when orientation is valid.
Position and orientation each have independent valid/tracked flags. Never treat an
invalid zero transform as real tracking. Activity is optional for pose sources whose
API has no activity flag; controller inputs always include activity.

Pose sample arrays match descriptor pose definitions. Controller values match input
definitions and types. Body joints match the exact referenced skeleton version.
Body confidence is absent or finite in [0,1]. Actual fidelity (Low/High) and calibration
status are included whenever supplied, independently of client selection. Body joints
carry validity flags, without per-joint confidence or velocity.

Reference space 1 has a fixed advertised kind. Nonzero sample reference versions
are recenter counters; they do not require a definition message or a client lookup.
The initial descriptor reference records the counter at acceptance. No continuity
transform is promised across recenter. This removes a cross-channel race that used
to discard samples until a content-free definition arrived.

Skeleton 2 has immutable nonzero increasing versions. Samples reference the exact
skeleton used at acquisition, retained with their history. The server sends skeleton
definitions before data, but channels can race: discard body samples with unknown
skeletons. Skeleton rest geometry is absolute within its recorded reference version,
not parent-relative. Joint IDs are unique signed-32-bit-compatible values, parents
are existing IDs or -1 and the graph must be acyclic. The operator validates 70 joints
and finite rest geometry. It refetches on runtime skeleton changes and recenter; the
headset's exact rest-space convention still needs physical validation. The recorded
reference counter does not depend on a second metadata message.

## Time and freshness

Server timestamps are signed 64-bit nanoseconds on one session-relative monotonic
clock. They are not UTC and cannot be compared across server sessions or directly to
OpenXR's runtime epoch. Runtime target/body-return/input-change times stay absent
until explicitly converted and validated on Quest. Synthetic test data may supply
those fields using the test server's clock. Missing is distinct from zero.

ClockProbe/ClockReply use the tracking channel, with client send/receive timestamps
and server receive/send timestamps. Subtract server processing time from the client
round trip; map clock offset using the midpoints. Delayed/lost probes do not block
tracking. Timestamp age is diagnostic and does not authorize hardware actions.
The Viewer marks data stale after 500 ms without fresh samples; invalid/inactive
samples remain visible as such, not live input. Resume invalidates clock mapping.
