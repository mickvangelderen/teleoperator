# Tracking checkpoint

Implemented: OpenXR passthrough and head + left/right grip/aim acquisition;
shared 100 Hz pose subscriptions; independent 1–100 Hz publication; 1–8 samples
of consecutive history; bounded transport buffering; Viewer pose visualization,
sequence and consumer statistics. The only supported base is Local (ID 1), with
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

Synthetic acquisition through the real native WebRTC server and Chromium,
unordered tracking channel with zero retries. Two clients shared acquisition.

| 10-second observation | 60 Hz consumer | 5 Hz consumer |
| --- | ---: | ---: |
| Received messages | 977 | 995 |
| Received rate | 97.7 Hz | 99.5 Hz |
| Missing message sequence numbers | 0 | 0 |
| Consumed updates | 616 | 50 |
| Deliberately coalesced updates | 361 | 945 |
| Malformed/unknown discarded packets | 0 | 0 |

Blocking the slow client's JavaScript thread for two seconds left the fast client
receiving at 96.6 Hz over a three-second observation. The slow client recovered,
retaining at most one pending sample. A 10 Hz publication update measured 10.3 Hz
and preserved the subscription identity. Deliberately discarding 28 tracking
messages in the receiver produced exactly 28 additional sequence gaps.

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

Remaining project checkpoints: controller buttons/analog inputs and transition
counters; body tracking, permissions, skeleton metadata and visualization; final
hardware review. `IDEA.md` remains the project scope and has not been modified.
