# Tracking checkpoint

Implemented: OpenXR passthrough, head + left/right grip/aim poses, 27 controller
inputs, and the default 70-joint body set; shared 100 Hz acquisition; independent
1–100 Hz publication; 1–8 samples of consecutive history; bounded transport
buffering; Viewer spatial visualization, sequence and consumer statistics.
The only supported base is Local (ID 1), with
AcquisitionTime targeting. Velocities are not advertised. Unavailable optional
pose selections are explicitly omitted; unsupported required settings are rejected.

The OpenXR loader is Khronos 1.1.65, downloaded from Maven Central and checked
against a pinned SHA-256 by `prepare-loader.py`. The headset uses an immersive
GLES binding with a small pbuffer and a passthrough composition layer; no scene
rendering or eye swapchains are needed. The sampler runs independently of the
display frame loop. Reference-space changes are versioned; timestamps use the
server's monotonic epoch. Runtime target times remain absent until a conversion
into that epoch is implemented.

## Measured locally, 2026-11-05

Final run at 10:53 UTC: synthetic acquisition through the real native WebRTC
server and Chromium, unordered tracking channel with zero retries. Two clients
shared acquisition with pose, controller, and body streams active concurrently.

| 10-second observation | 60 Hz consumer | 5 Hz consumer |
| --- | ---: | ---: |
| Received pose messages | 1,000 | 989 |
| Received rate | 99.96 Hz | 98.86 Hz |
| Missing message sequence numbers | 0 | 0 |
| Consumed updates | 625 | 50 |
| Deliberately coalesced updates | 375 | 939 |
| Malformed/unknown discarded packets | 0 | 0 |

Controller and body streams received 990–1,000 messages each with zero sequence
gaps or discarded packets. Counter deltas are sampled from a running connection;
a pending sample at the interval boundary can make consumed + coalesced differ
from received by one.

Blocking the slow client's JavaScript thread for two seconds left the fast client
receiving at 99.95 Hz over a three-second observation. The slow client recovered,
retaining at most one pending sample. A 10 Hz pose publication update measured
10.33 Hz and preserved the subscription identity. Body publication at 30 Hz with
eight historical samples measured 29.96 Hz with no malformed/unknown packets.
No sender backpressure skips or send errors occurred; peak buffered bytes were
18,616 with the larger body history.

Deliberately discarding 25 pose messages in the receiver produced exactly 25
additional sequence gaps. A dropped final message cannot be
identified until a later sequence number arrives; this is expected for a
sequence-based metric on an unreliable channel.

The browser's SCTP implementation continues acknowledging while JS is blocked.
This is a consumer/backlog test, not evidence of network congestion or headset
performance. Receiver-injected drops test the accounting, not actual network loss.
Full measurement output and desktop/mobile captures: `.artifacts/tracking/`.
Repeat with `pnpm test:tracking` as described in the Viewer README.

## Validation still requiring the Quest

The Android APK builds, but this tracking checkpoint has not been deployed or
validated on hardware: the headset went to sleep and is unreachable. Verify
passthrough, known head/controller translations and rotations, active/invalid
flags, pause/resume, recentering, repeated reconnects, and Wi-Fi loss/latency.
Do not treat synthetic transport tests as validation of spatial calibration.

The controller checkpoint adds 27 inputs and supports up to three independent
streams per peer. Both pose and controller requests share resolved acquisition
across peers. Controller counters accumulate at acquisition time, rebaseline
without edges after activity loss, and survive publication-rate changes. Runtime
Boolean conversions are advertised; application hysteresis rules and Touch Plus
finger-sensing extensions are not advertised. Input last-change timestamps remain
absent until runtime-time conversion is validated.

Publishing controller inputs at 1 Hz for 3.2 seconds delivered
three snapshots carrying three additional presses and releases, while retaining
the same subscription. This verifies counter recovery across unreceived changes.

The body checkpoint implements the default 70-joint set, permission requests and
revocation, skeleton version changes, quality reporting, and visualization. It
retains immutable skeleton definitions alongside sample history, including history
that crosses a skeleton change. Three streams share the same WebRTC connection;
subscription retirement and capability loss are reported over reliable control.
The Viewer rejects unknown metadata, malformed geometry, cyclic skeletons and
metadata versions whose contents change.

All original core implementation steps now have code and local validation.
Remaining qualification is on the Quest: passthrough appearance, actual controller
bindings, permission UI, body activation, skeleton coordinates, recenter/resume,
and real network loss/latency. The Viewer uses wireframe guides; no Meta model
assets have been imported. Optional protocol settings are listed in the Operator
README and are rejected when unavailable rather than silently substituted. `IDEA.md` remains the project scope and has not been modified.
