# XR Operator

Rust Android application for Meta Quest 3, with a TypeScript web Viewer.
The roadmap is in [IDEA.md](IDEA.md).

The standalone Android project, build instructions, and deployment script are
in [operator/](operator/README.md).

The [Viewer](viewer/README.md) connects to the Quest over WebRTC and inspects
the hello exchange, session identity, capabilities, and clock round trips.
Tracking is acquired at 200 Hz and published at 100 Hz with up to two samples per
message by default. The Viewer consumes and renders at the display frame rate,
with bounded history, loss statistics, and a slow-consumer mode. The Android build includes
OpenXR passthrough. Controller buttons, touch states, triggers, grips, and thumbsticks stream alongside
poses with shared transition counters. Body tracking exposes the default 70-joint
set, versioned skeletons, and runtime quality information. All three streams can
be inspected together in the Viewer. The APK has been deployed and tested remotely
on the Quest; physical movement and controller checks still need hands-on validation.
See [tracking validation](operator/TRACKING.md) for measurements and hardware limits.

Install Python 3, Node.js 22.18+ and pnpm 12.10.1. Builds automatically download
and cache the pinned **flatc 25.9.23** compiler (see
[protocol setup](protocol/README.md#generate-and-check)). From `viewer/`:

```sh
pnpm install --frozen-lockfile
XR_OPERATOR_URL=http://QUEST_IP:8080 pnpm dev
```

Open `http://127.0.0.1:5173` and select **Connect**. The browser and Quest must
have direct network connectivity. A desktop server using the same implementation
is available for development: `cargo run --manifest-path operator/Cargo.toml`.

The [protocol design](protocol/PROTOCOL.md), [wire-format description](protocol/README.md),
and [FlatBuffers schema](protocol/wire.fbs) are in `protocol/`.
