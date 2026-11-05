# FlatBuffers wire-format proposal

[wire.fbs](wire.fbs) is the protocol version **1** schema, based on
[PROTOCOL.md](PROTOCOL.md). The [operator](../operator/README.md) and
[Viewer](../viewer/README.md) implement hello negotiation, empty discovery, and
clock probes over WebRTC. Tracking acquisition and subscription fulfillment
remain a draft; their descriptions below do not claim tested Quest capabilities
or performance.

## Framing and negotiation

Send one ordinary, **non-size-prefixed** `Packet` FlatBuffer per binary WebRTC
data-channel message, including the `XROP` file identifier. WebRTC supplies the
message boundary; do not concatenate packets or add a custom length header.
Use the generated finish function that writes the identifier. Check the
identifier, buffer structure, union tags, channel, direction, and connection
state before interpreting the payload using the negotiated version.

| Channel | Client to server | Server to client |
| --- | --- | --- |
| Reliable ordered control | `ClientHello`, `Subscribe`, `UpdatePublication`, `Unsubscribe` | `ServerHello`, `Capabilities`, `StreamAccepted`, `RequestRejected`, `StreamClosed`, `SubscriptionRetired`, metadata definitions, `ServerResumed` |
| Unordered, zero-retry tracking | `ClockProbe` | `Tracking`, `ClockReply` |

1. Send `ClientHello` with a nonempty, duplicate-free list of supported versions.
   The `Packet` envelope and hello layouts are stable across versions so they
   can be decoded before negotiation. The client hello has no session ID.
2. The server selects the highest common version. `ServerHello` echoes the
   request ID, lists server-supported versions, and supplies `server_session_id`.
   No common version means `selected_version = 0`, a nonempty rejection reason,
   no session ID, and no further protocol traffic.
3. The accepted version and server session ID become immutable connection
   context shared by both channels. Subsequent packets contain only their
   message and inherit this context. Drop tracking received before negotiation
   completes. Reject subscription requests before negotiation. Reconnects
   perform a new handshake; callbacks from a retired connection retain their
   original context and must not update the new connection's state.
4. The server sends a full `Capabilities` snapshot before accepting subscriptions.
   Later snapshots replace discovery state in receive order on the reliable
   ordered control channel; no revision counter is carried. They do not modify
   existing subscription descriptors. Profile changes are reported through the
   per-hand `ControllerSource` entries in these snapshots.

Use a proposed 64 KiB control-message ceiling before discovery. Advertised
control limits cannot exceed it in version 1. Tracking limits must fit the
negotiated WebRTC maximum message size. Limits apply to the whole encoded
packet, including history, tables, strings, and framing. Do not split a snapshot
into dependent packets. A server must reject configurations whose minimum
complete snapshot cannot fit. These are ceilings, not recommended packet sizes.

## Identifiers, numbers, and units

| Representation | Meaning |
| --- | --- |
| `SessionId { low:ulong, high:ulong }` | Opaque, nonzero 128-bit value freshly generated at application startup; equality compares both words; no UUID byte-order convention |
| `ulong` | Unsigned 64-bit subscription, stream, request, sample, message, and transition numbers |
| `long` | Signed 64-bit nanoseconds, including timestamps and prediction offsets |
| `MetadataRef { id:ulong, version:uint }` | Session-scoped metadata identity and unsigned 32-bit version |
| `uint` / `int` | Counts, byte limits, joint IDs / parent IDs (`-1` means no parent) |
| `float` | IEEE 754 binary32 values, positions, orientations, velocities, rates, confidence, thresholds |

Session identity scopes subscriptions, streams, and metadata. Stream IDs are
unique across the server session, even across clients, and never reassigned.
Subscription and metadata IDs are also never reassigned in their respective
namespaces. Reference-space and skeleton IDs have separate namespaces.
IDs, metadata versions, sample numbers, and message numbers start at
1. Transition counts start at 0. Zero stream ID requests creation; zero response
request ID denotes a server notification. Control request IDs are nonzero and
never reused within a connection. Probe IDs have a separate, nonzero,
connection-local namespace. Echo IDs in responses; neither exchange consumes
tracking counters.

No counter or ID wraps. Close or retire the affected stream, subscription, or
connection before exhaustion; use a new identity to restart its sequence.
Exhaustion of a session-scoped identity namespace requires a new server session.
TypeScript uses `bigint` for **all** 64-bit fields, not only timestamps. Convert
only bounded differences to `number` when needed.

All server timestamps use signed 64-bit `server-monotonic` nanoseconds. Supporting
this clock is mandatory for every server. It is fixed by the protocol, cannot be
configured by clients, and is neither advertised nor negotiated. No clock-domain
field is needed in capabilities, descriptors, or the handshake.

Optional timestamps are `long = null`: absence means unavailable or invalid,
while **zero is a representable timestamp**. Runtime timestamp conversion failure leaves that
timestamp absent; it does not turn the raw OpenXR timestamp into a server time.
`acquired_at`, clock-reply times, and `resumed_at` must be valid application clock
readings. `received_at`/`sent_at` in `ClockReply` are t2/t3; t1 stays at the
client, which records t4 on receipt.

Version 1 fixes metres, seconds, metres/second, and radians/second for geometry
and velocities. Coordinates are right-handed, +X right, +Y up, -Z forward;
quaternions are `(x, y, z, w)` rotations from the located source into the base
space. These conventions are mandatory, cannot be configured, and are not
advertised in capabilities or descriptors. Selecting a base space does not change
them. Valid orientations are unit quaternions. Input definitions supply their
own units and ranges. Scalar ranges use `Vec2.x` with `y = 0`; two-axis ranges
use both components. Boolean inputs omit numeric ranges. Confidence is in
`[0, 1]` when present. Rates must be finite and positive; usable numeric values
must be finite. Invalid geometry is ignored according to flags, never interpreted
as a valid zero pose.

## Discovery, requests, and descriptors

An absent controller/pose/body capability table means that kind is unsupported.
Advertised acquisition rates and target-time entries enumerate supported
choices, while publication rates use the advertised inclusive range. Lists
describe individual choices, not a promise that every combination is available
simultaneously. Restrictions explain permission or runtime constraints; actual
request validation may reject a combination and supply concrete alternatives.
Limits must be positive, with minimum send rate no greater than maximum send
rate and maximum history length at least 1. Publication defaults resolve a
positive send rate and history length within the advertised limit. The current
operator advertises 100 Hz publication with history length 2 and 200 Hz acquisition.
A supplied publication table with an omitted history field still means 1, as
defined by the wire schema. Accepted publication settings are fully
resolved and within both retention and encoded-message limits.

`InputDefinition` keys are `(source_id, input_id)`. Meanings belong to stable
protocol input IDs; device labels and interaction profiles are supplementary.
Use vendor-qualified IDs for controls without common meanings. Exact canonical
names and normalization remain a separate vocabulary decision. Body joint-set
strings likewise identify a defined joint vocabulary; names for the 70- and
84-joint sets remain to be agreed.

`Subscribe` creates a stream when `stream_id = 0`; otherwise it replaces that
stream's entire acquisition request. Sources/inputs are explicitly selected.
`Required` and `Optional` express support requirements; `Omit` is invalid for a
listed source/input but valid for velocities. Empty controller and pose
selections are invalid, including after resolving optional selections.
Required support does not imply current activity.

The settings union is reused for requests and resolved configurations:

- Resolve absent acquisition fields against the corresponding advertised
  defaults. For a Boolean with no requested rule, use the first advertised
  `boolean_rules` entry for that input. A non-Boolean must not have a rule.
  Defaults must themselves be complete, supported configurations. Reject values
  that are explicitly supplied but unsupported.
- Runtime Boolean rules use the prepared OpenXR Boolean action. Hysteresis
  rules reference a scalar input on the same source and require finite
  `release_threshold <= press_threshold`, within that input's range. False
  changes to true at `value >= press_threshold`; true changes to false at
  `value < release_threshold`. Reacquisition initializes from the press threshold
  without changing counters. The analog input need not be published.
- A missing publication table uses advertised defaults for a new stream and
  preserves current settings for an existing stream. A supplied table is a
  complete replacement: missing send rate uses the advertised default, and
  missing history length means 1. `UpdatePublication` follows the same replacement
  rule and cannot change acquisition.
- Resolved descriptors have no unresolved acquisition fields. Selected inputs
  and sources use `Required`; selected velocities become `Required` and unselected
  velocities become `Omit`. Explicitly list unavailable optional choices in
  `StreamAccepted.omissions`. Retain the client's original requirements at the
  server for later capability-loss decisions.
- Resolve controller selections in lexicographic `(source_id, input_id)` order
  and pose selections in lexicographic `source_id` order (UTF-8 bytes). Reject
  duplicates. Subscription sharing compares resolved settings and interpretation,
  excluding client requirements, publication settings, labels, and current
  metadata versions. Do not compare raw FlatBuffer bytes for equality.

`TargetTime.offset_ns` is zero except for `AcquisitionOffset`, where it is added
to acquisition time. `PredictedDisplayTime` requests the current XR frame's
predicted display time. Advertise only policies the implementation can supply.
Every descriptor resolves this choice explicitly. A body fidelity preference
does not guarantee matching actual fidelity.
`Default` is a request preference only; reported actual fidelity is `Low` or
`High`. Unknown actual fidelity is absent. Calibration status maps the runtime's
valid/calibrating/invalid states; unavailable status is absent.

Body samples always include actual fidelity and calibration status when the
runtime supplies them. Their support is advertised by `BodySource`, but their
inclusion is not configurable. Availability changes do not alter acquisition
configuration or require a subscription switch. The acquisition fidelity
preference remains configurable.

`StreamAccepted` acknowledges both subscribe and publication-update requests.
It carries the complete descriptor, current publication settings, and omissions
(an empty vector when none). `RequestRejected` leaves the previous stream
unchanged; alternatives are full resolved settings that a client can request,
not settings the server applied automatically. Include alternatives when an
unsupported setting has available choices; an empty list means none are offered.

Only control messages change associations. A server-initiated switch uses
`StreamAccepted` with request ID 0. `StreamClosed` acknowledges unsubscribe or
reports closure, including loss of a required capability; server closures use
request ID 0. Detaching a stream does not reset a shared subscription.
`SubscriptionRetired` reports that an unused subscription has been retired.
No automatic capability-loss recovery is specified. `ServerResumed` invalidates
the client's clock mapping without resetting subscription counters.

## Sample layouts and metadata

Connection context supplies the session ID, and `Tracking` supplies stream,
subscription, and message numbers. `Tracking.history` selects exactly one of
`ControllerSamples`, `PoseSamples`, or `BodySamples`, each containing `samples`.
The sample kind must match the associated descriptor's acquisition union.

| Sample kind | Layout and validity |
| --- | --- |
| Controller | `values[i]` matches both resolved `inputs[i]` and descriptor `inputs[i]`; its value union must match `InputDefinition.value_type`. Every selected input is present, including inactive ones. Inactive Boolean counts remain meaningful; its current value and change time do not establish live input. |
| Pose | `poses[i]` matches resolved `sources[i]` and descriptor `pose_sources[i]`. Position and orientation validity/tracking are independent bits. `is_active = null` means the source API provides no activity flag. Selected velocities have a `Velocity` table even when both validity flags are clear; unselected velocities omit it. |
| Body | `joints[i]` matches `SkeletonDefinition.joints[i]` for the descriptor's skeleton ID and that sample's `skeleton_version`. All joint transforms are in the selected base space. Activity/confidence apply to the body; there are no per-joint confidence or velocity fields. Actual fidelity and calibration status are included whenever available in that sample. |

Each sample is complete and independent. A scalar field omitted by the
FlatBuffers builder decodes to its schema default within that sample; it never
means "reuse the previous sample." Every history vector is nonempty, has at most
the accepted history length, and contains consecutive sample numbers oldest to
newest, ending with the latest available sample. An overlapping sample preserves
all its contents. Initial/switch reception baselines controller counters; history
must not replay transitions into live state. Freshness and counter rules remain
those in `PROTOCOL.md`.

Controller descriptors require `inputs`, pose descriptors require `pose_sources`
and `initial_reference_space`, and body descriptors require
`initial_reference_space` and `initial_skeleton`. Irrelevant definition/reference
fields are absent. Definitions match the resolved selections exactly, and a
body skeleton's joint set and joint inventory must match the selected joint set.
Descriptors include complete selected input/pose definitions. Their initial
metadata references identify definitions to send with acceptance and fix the
metadata IDs for the subscription's lifetime. `initial_reference_space.id` must
equal the resolved base-space ID. Pose and body samples carry only
`reference_space_version`; body samples also carry `skeleton_version`. Combine
these nonzero versions with the descriptor's fixed IDs to look up definitions.
Changing a metadata ID requires another subscription. Definitions retain their
full `{id, version}` references. Metadata versions are immutable, nonzero, and
increase within their identity. Retain definitions needed by retained history.
Unknown associations or metadata cause sample discard, not waiting or guessing.

`ReferenceSpaceDefinition.pose_in_previous` describes the new origin in the
previous reference-space version and is absent when that relation is unknown.
It requires `previous` when present. `effective_at` is the converted runtime
change time, if known. Skeleton joint IDs are unique within the joint set, fit
signed 32 bits for parent references, and parents name existing joints or `-1`;
the parent graph must be acyclic. Skeleton rest poses use the explicitly named
`SkeletonDefinition.reference_space`; retain that definition too. They are not
parent-relative. The OpenXR specification describes skeleton poses in a base
space, so the server must identify that space/version when publishing geometry.
Verify the returned convention on the target runtime before implementing this
mapping. Live joint poses use each sample's acquisition base-space version.
See [OpenXR skeleton geometry](https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrBodySkeletonJointFB.html).

## Validation and evolution

Generated structural verification is necessary but insufficient. Enforce the
channel/direction and lifecycle rules above, bounded strings/vectors, valid
nonzero identities, known enum/union values, resolved settings, vector lengths,
type matches, finite values and ranges, known metadata, and sample ordering.
`(required)` ensures presence, **not a nonempty vector or a nonzero scalar**.
Do not use unchecked Rust readers on received buffers. A TypeScript receiver
also needs bounds and semantic validation; generated accessors alone are not a
protocol validator. Limit encoded size and parser work before consuming data.
Malformed tracking packets are discarded without changing live state. Invalid
control requests with readable request IDs receive `RequestRejected`; structurally
invalid or out-of-state control traffic terminates the connection.

Tables can gain fields at the end; do not remove/reorder fields, change their
types/defaults, or add new required fields to an existing version. Enums and
unions have fixed numeric tags; append entries without reusing numbers. Structs
(`JointPose`, transforms, IDs) have a fixed layout and cannot gain fields.
An incompatible layout or interpretation needs a new negotiated protocol version.
Senders must only use messages/features defined by the negotiated version;
unknown tags are not silently interpreted as a common control. These rules
follow [FlatBuffers schema evolution](https://flatbuffers.dev/evolution/).

## Generate and check

Both applications pin **flatc 25.9.23** and matching Rust/TypeScript runtimes.
Install **Python 3**; no separate compiler installation is required. Cargo builds
(including `cargo apk build`) and the Viewer's `dev`, `build`, `test` and `generate`
commands invoke [`tools/flatc.py`](../tools/flatc.py). It reuses a matching compiler
on PATH, otherwise downloads an [official prebuilt binary](https://github.com/google/flatbuffers/releases/tag/v25.9.23),
checks its pinned SHA-256 and version, and caches it under
`.artifacts/tools/flatc-25.9.23/<host>/`. A different system version is skipped.
The first download needs network access; subsequent builds reuse the cache offline.
No CMake or C++ toolchain is required.

Automatic downloads support Linux x86-64, macOS Intel/Apple Silicon, and Windows
x86-64, using the build host rather than the Android target. On other hosts, build
the pinned version from source and set `FLATC` to its executable. An explicit
`FLATC` override takes precedence and fails clearly if its version is wrong.

Generated files are ignored:
Rust writes to Cargo's `OUT_DIR`, and `pnpm generate` writes to `viewer/src/generated`.
Nothing generated is checked in. To check the schema directly from the repository root:

```sh
python3 tools/flatc.py --rust --ts -o .artifacts/protocol/generated protocol/wire.fbs
```

The compiler setup checks run with `python3 -m unittest discover -s tools`.

The implemented signaling contract, channel labels, and connection limits are
documented in [operator/README.md](../operator/README.md#transport). The Viewer
currently rejects nonempty tracking discovery as unsupported, rather than
interpreting unimplemented fields or displaying fabricated poses.

## Choices to discuss before implementation

- The reused request/descriptor settings reduce duplicate types but require
  explicit validation that a descriptor is fully resolved. Separate types could
  move some of those checks into generated APIs.
- Controller values use a table and typed union per input for straightforward
  decoding and evolution. Body joints use a 32-byte fixed struct: 70/84 joints
  cost 2,240/2,688 bytes per sample before tables and framing. Measure real packet
  sizes with history before deciding whether controller values also need packed,
  type-grouped vectors.
- Defaults are advertised rather than fixing rates or prediction policy in the
  schema. Acquisition choices are discrete lists in this draft. Decide whether
  arbitrary rate/offset ranges are needed after testing supported configurations.
- Canonical input/source/joint-set IDs, binding coverage, normalization, device
  limits, stale-input policy, and clock-estimator tuning still need agreement and
  target-device measurements. None of the advertised capability tables invents
  support that the runtime has not supplied.
