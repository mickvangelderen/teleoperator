# FlatBuffers encoding

[wire.fbs](wire.fbs) is protocol **version 2**. The operator and Viewer implement
pose, controller and body tracking. [PROTOCOL.md](PROTOCOL.md) is the single source
for lifecycle, acquisition, counters, coordinates, timestamps and metadata semantics.

## Framing and validation

Each binary WebRTC message contains one ordinary, non-size-prefixed Packet with the
`XROP` identifier. No concatenation or extra length header. The Packet and hello
layouts/tags are stable so an old peer receives a version rejection. All other v2
layouts are incompatible with v1; do not infer a version from a payload shape.

| Channel | Client sends | Server sends |
| --- | --- | --- |
| reliable ordered control | ClientHello, Subscribe, UpdatePublication, Unsubscribe | ServerHello, Capabilities, StreamAccepted, RequestRejected, StreamClosed, SkeletonDefinition, ServerResumed |
| unordered zero-retry tracking | ClockProbe | ClockReply, Tracking |

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
