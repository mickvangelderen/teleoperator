# FlatBuffers encoding and current wire contract

[PROTOCOL.md](PROTOCOL.md) defines the device-independent design requirements.
This document describes the **version 2** contract implemented by the
[operator](../operator/README.md) and [Viewer](../viewer/README.md), including
encoding constraints and the current limitations of [wire.fbs](wire.fbs).

## Design and implementation status

The acquisition-group design is not yet implemented in v2. Do not interpret the
current global sequence or fixed acquisition settings as device-independent
requirements, or assume this documentation changes what a v2 peer can decode.

| Design requirement | Current v2 behavior |
| --- | --- |
| Acquisition boundaries and sequences follow source groups. | One complete tick supplies controller, pose, and optional body data. There is one session-wide sample sequence and no group identity in the schema. |
| Independently acquired groups have their own histories. | Streams filter one shared eight-tick history. Body history stops at the latest body-availability gap. |
| Devices advertise supported acquisition choices and effective settings. | `Capabilities.sample_rate_hz` is one read-only cadence for all kinds. The operator advertises 200 Hz; requests select data but cannot change acquisition. |
| Publication limits and defaults come from capabilities. | The operator advertises 1–200 Hz publication, history 1–8, and defaults of 100 Hz with up to two samples. |
| Shared acquisition requests have explicit arbitration. | No acquisition-rate request exists, so v2 has no rate-arbitration mechanism. Publication requests do not create acquisition loops. |
| Reference changes retain their meaning across groups. | One reference space uses recenter versions; no continuity transform or effective-change timestamp is transmitted. |

Implementing independent acquisition requires coordinated changes to the schema,
descriptors, server histories/publisher, and client validation/statistics. Decide
the supported acquisition choices and sharing/arbitration rules first; keep unused
negotiation features out. An incompatible contract change requires version
negotiation under the [evolution rules](#evolution), not a reinterpretation of v2.

## Framing and validation

Each binary WebRTC message contains one ordinary, non-size-prefixed Packet with the
`XROP` identifier. No concatenation or extra length header. The Packet and hello
layouts/tags are stable so an old peer receives a version rejection. All other v2
layouts are incompatible with v1; do not infer a version from a payload shape.

| Channel | Client sends | Server sends |
| --- | --- | --- |
| reliable ordered control | ClientHello, Subscribe, UpdatePublication, Unsubscribe | ServerHello, Capabilities, StreamAccepted, RequestRejected, StreamClosed, SkeletonDefinition, ServerResumed |
| unordered zero-retry tracking | ClockProbe | ClockReply, Tracking |

The channel labels are `control` and `tracking`, with subprotocol `xrop`. HTTP
signaling and peer-disconnection behavior are documented in
[operator transport](../operator/README.md#transport).

Reject packets larger than 65,536 bytes before parsing. Rust uses the generated
verifying root reader plus identifier and semantic checks. TypeScript uses bounded
table reads because the generated runtime has no verifier. Check offsets, vector
lengths, strings, tags, required fields, finite geometry, enums, identities, ranges,
ordering and descriptor/type compatibility before updating live state. `(required)`
means presence, not nonempty or nonzero. Never use unchecked Rust readers on input.
The Viewer caps history at eight, input vectors at 128, pose vectors at 64, skeletons
at 84 and strings at 2048 bytes. Actual server limits are smaller and advertised.

All 64-bit fields use TypeScript bigint. Do not round IDs through Number; only convert
bounded time differences for UI statistics. Scalar defaults are local to each sample,
never instructions to reuse a previous value. Null optional scalar timestamps differ
from zero. SessionId compares both 64-bit words. MetadataRef has a 64-bit ID and 32-bit
version. JointPose is a fixed 32-byte struct with a transform and validity flags.

Malformed control, invalid request-ID ordering, and unexpected message types
terminate the connection. Valid requests with unsupported settings receive
RequestRejected without changing existing streams.
Tracking before hello acceptance, malformed tracking, and samples without the
required descriptor or skeleton are discarded without updating live state.

## Version 2 messages and semantics

### Hello, requests, and discovery

ClientHello is first, with a nonzero request ID and 1–32 unique nonzero supported
versions. ServerHello echoes that ID and advertises [2]. Acceptance selects 2 and
includes a nonzero random 128-bit server session ID; rejection selects 0, includes
a reason, and omits the session. Version and session context then remain fixed for
both channels. Requests before acceptance are rejected; hello cannot be repeated
after acceptance or rejection. Capabilities follows successful hello.

Control request IDs strictly increase within a connection. Probe IDs form a
separate nonzero namespace; repeated probes may receive repeated replies, and
clients ignore replies without a pending ID. Neither uses tracking counters or a
lifetime request budget. Server-initiated StreamClosed uses request ID 0.

Capability snapshots replace discovery in receive order without changing accepted
descriptors. Absent capability tables mean unavailable kinds. Controller-source
inventory is derived from input definitions; v2 has no separate interaction-profile
advertisement. Support never implies current activity.

### Selections and publication

Subscribe creates a new stream. Controller selection uses `(source_id, input_id)`
pairs, pose selection uses source IDs, and body selection uses the advertised source
and joint-set identity. All selections are required. Reject duplicate, empty, or
unknown selections; sort inputs and poses lexicographically by source and input ID.
StreamAccepted echoes the request with the complete descriptor and publication
settings. Stream IDs are nonzero and never reused within the server session.

UpdatePublication changes only rate/history and acknowledges the same stream.
Selection changes require Unsubscribe and a new Subscribe. StreamClosed acknowledges
unsubscribe or reports capability loss. Losing body capability closes only body
streams; inactive tracking with a valid skeleton can still produce inactive samples.
ServerResumed tells clients to invalidate clock mappings immediately.

PublicationSettings is a replacement, not a patch. With the current operator:

| Request | Resolved settings |
| --- | --- |
| Publication table absent on Subscribe | Advertised defaults: 100 Hz and history 2. |
| Table present, send rate absent | 100 Hz; not the stream's previous rate. |
| Table present, history omitted | 1, the schema field default. |
| Explicit values | Accepted only within advertised limits. |

Publication never waits to fill history. A present table's omitted history uses the
schema default rather than copying the advertised default; its omitted send rate is
resolved by the server.

### Tracking and metadata

Tracking contains a stream ID, message number, and a nonempty history union of one
payload kind. In v2, samples share the server's global tick number, starting at one.
Each history ends at the latest available sample, has consecutive sample numbers
and nondecreasing acquisition times, and never exceeds the accepted length. Message
numbers advance only on accepted transport sends. Retained sample contents are
immutable and counters do not wrap.

Controller values match descriptor definitions and types. Scalars are normalized
to [0,1], vector components to [-1,1]; active numeric values must be finite. Boolean
values include cumulative counts even while inactive. Pose samples match descriptor
pose order. Body samples match their exact skeleton version, with absent or finite
[0,1] confidence, optional Low/High fidelity and calibration status, and joint flags.
The schema has no velocity or per-joint confidence fields.

Descriptors fix reference-space ID 1 and skeleton ID 2; sample fields carry their
nonzero versions. These literal IDs are current v2 restrictions, not portable
meanings for arbitrary metadata identities. The reference-space kind is advertised
and fixed for the session. Its version is a recenter counter and needs no separate
definition message. No continuity transform is promised.

Skeleton versions are immutable and increasing. Send definitions before associated
data, retain the exact versions needed by history, and discard body samples whose
skeleton is not yet known across the channel race. Rest geometry is absolute within
the recorded reference-space version, not parent-relative. Joint IDs are unique
signed-32-bit-compatible values; parent IDs refer to existing joints or -1 and must
form an acyclic graph. Backend joint-count checks and skeleton retrieval are described
in the [operator settings](../operator/README.md#body-permission-and-supported-settings).

Server timestamps use signed 64-bit nanoseconds. The current operator maps them to
one session-relative monotonic epoch. Optional target, returned-data, and input-change
timestamps must be in that same domain. Their availability and device conversions
are backend behavior; absent timestamps are never replaced with acquisition time.
ClockReply returns server receive/send times, while the client retains its own probe
send/receive times. Estimator and freshness tuning belong to the
[Viewer](../viewer/README.md#clock-mapping-and-freshness).

## Evolution

Within a version, append optional table fields and enum/union tags. Do not remove or
reorder fields, change types/defaults, add required fields or alter fixed structs.
An incompatible revision needs a new negotiated version. v2 deliberately removes
unimplemented v1 settings; hello remains stable. No generated files are checked in.

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
