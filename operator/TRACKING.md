# Historical tracking checkpoint (protocol v1)

These measurements and behaviors describe protocol v1 through `d87ffd5`, before
the v2 simplification.
They are retained as historical evidence, not validation of the current revision.
See [current semantics](../protocol/PROTOCOL.md) for the updated behavior.
Physical Quest checks must be repeated before deployment.

Implemented: OpenXR passthrough, head + left/right grip/aim poses, 27 controller
inputs, and the default 70-joint body set; shared 200 Hz acquisition; independent
1–200 Hz publication (default 100 Hz); 1–8 samples of consecutive history (default 2); bounded transport
buffering; Viewer spatial visualization, sequence and consumer statistics.
The supported base (ID 1) is the runtime's Local Floor space when available,
with an explicitly advertised Local fallback and AcquisitionTime targeting.
Velocities are not advertised. Unavailable optional
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

The APK has now been deployed and tested remotely on the Quest; see the hardware
results below. Hands-on checks still need passthrough appearance, known
head/controller translations and rotations, button transitions, body alignment,
and deliberate recentering. Remote transport tests do not validate physical calibration.

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
Remaining hands-on qualification includes passthrough appearance, actual controller
bindings, first-run permission UI, skeleton alignment and deliberate recentering.
Remote body activation, lifecycle and network checks are recorded below.
The Viewer now uses Meta hardware and Movement meshes with a Three.js
renderer; its source/license manifest and rendering checks are in the Viewer README. Optional protocol settings are listed in the Operator
README and are rejected when unavailable rather than silently substituted. `IDEA.md` remains the project scope and has not been modified.

## Meta assets and WebGL checkpoint

The Viewer now uses Three.js 0.186.1 with Meta hardware and body meshes, following
OpenArm Teleop’s rendering technology. The browser checks cover model loading,
orbit controls, desktop/mobile sizing and missing-asset handling. A unit test loads
the actual body GLB and verifies first-frame rigid motion, repeated samples and
invalid-data visibility. Twelve Viewer unit tests and the production build pass.

The 17:11 UTC local transport rerun with the WebGL Viewer also passed: both
receivers measured about 100 messages/sec with zero observed sequence gaps. This
remains synthetic acquisition, not Quest or Wi-Fi qualification. The synthetic
head/controller fixtures move independently of the body fixture, so their meshes
do not represent a single person wearing and holding the devices.

## Quest validation, 2026-11-05

Deployed to the Quest 3 over authorized USB ADB, with no requested user interaction.
Signaling used `192.168.2.9:8080`; the selected WebRTC UDP candidate was verified
against the headset's Wi-Fi interface. There was no USB data tunnel. The Oculus
runtime reported version 209.166.0, and `LOCAL_FLOOR` was available through
`XR_EXT_local_floor`. All pose and body locations now use this runtime frame,
advertised as `LocalFloor` under session-scoped metadata ID 1. `Local` remains the
explicit fallback on runtimes without the extension. No guessed height offset is used.

The final 30-second delivery observation started at 17:48 UTC. Two separate
Chromium processes subscribed to all three streams; consumption was 60 Hz and
5 Hz respectively. These are observed rates, not a latency or loss guarantee.

| Stream | Fast receive rate | Fast sequence gaps | Slow receive rate | Slow sequence gaps |
| --- | ---: | ---: | ---: | ---: |
| Poses | 99.51 Hz | 14 | 99.01 Hz | 27 |
| Controller inputs | 99.74 Hz | 8 | 99.34 Hz | 18 |
| Body joints | 98.31 Hz | 51 | 98.11 Hz | 54 |

The gaps were approximately 0.27–1.80% of accepted message sequences. There were
no sender backpressure skips or send errors during this observation, and no
malformed/unmatched packets or unknown-metadata sample discards. Message numbering
advances only when WebRTC accepts a send, so sender skips do not explain these gaps.
This establishes end-to-end unreliable transport loss, not its precise network
layer or radio cause. Later arrival can still fill a sequence gap.

The slow consumer used 150 updates per stream, coalescing 2,796–2,832 while retaining
at most one pending sample. Blocking its JS thread for two seconds left the fast
receiver at 95.87–99.20 Hz; the slow receiver recovered with a single pending sample
and about 19 ms estimated sample age. Updates to 10 Hz pose, 1 Hz input and 30 Hz
body publication measured 10.00, 1.00 and 29.19 Hz respectively. Body history length
8 was decoded successfully. This block test does not simulate an unresponsive
SCTP stack: browser networking continues independently of JavaScript.

An earlier shared-browser stress run briefly fell to 64–67 Hz with backpressure
and failed its throughput threshold. The separate-process repeat above passed
the transport thresholds; differing runs do not isolate a single cause for that
dip. Raw reports retain both outcomes. A separate publishing timing issue found
during testing is fixed: a due publication now waits for fresh acquisition rather
than spending its slot on an unchanged sample. Regression tests cover this and
correct Local Floor/fallback metadata, including reference-version changes.

Final focused lifecycle checks at 17:53 UTC passed: sleeping made poses invalid
while preserving the WebRTC session; waking restored valid poses and advanced the
reference version. Home destroyed the activity in the final run; relaunch and a
new Viewer connection restored tracking with a new server session. Use the full
`MAIN`/`LAUNCHER` intent in `deploy.sh`; a bare component-only remote start earlier
left tracking inactive. USB deployment no longer enables wireless ADB, avoiding
an unrelated network-authorization dialog.

The Viewer browser checks passed against the device: hello/discovery/probes,
repeated reconnects, WebGL assets/orbit controls, mobile layout and error states.
Its camera now frames valid received points automatically without changing their
coordinates. A browser assertion checked 71 recorded head/body points, including
negative Local-space heights, and preserved subsequent manual camera control.
The final UI displayed `OPENXR · LOCAL FLOOR SPACE` and active body tracking;
the runtime reported calibration in progress. Controller availability varied
while unattended, so physical input and tracking alignment remain unqualified.

Reports and actual-device captures are in `.artifacts/quest/`: the separate-browser
measurement report, the retained shared-browser result, `final-check.json`,
`home-check.json`, and `viewer.png`/`workspace.png`/`joints.png`/`mobile.png`.
The combined measurement script's final assertion incorrectly assumed Home always
recreates the server session; this did not invalidate its recorded transport
measurements. The final focused lifecycle checks above tested actual validity
and session behavior instead. Thirteen Rust tests, clippy, twelve Viewer tests,
the Viewer production build and Android APK build also passed.

## History and rendering investigation, 2026-11-05

The Viewer now applies pending scene updates on `requestAnimationFrame` and draws
only dirty frames, with a continuous-rendering option for measuring idle frames.
The profiler separates animation-frame cadence, actual draw intervals, scene CPU,
and per-stream arrival intervals. A separate graph measures payload bytes over a
rolling second. Arrival intervals and transfer rates are included in dev recordings.

An unattended Wi-Fi comparison requested 100 Hz publication for all three streams,
used a 60 Hz consumer and continuous rendering, and changed history lengths with
roughly 12-second observations after each change. Another existing Viewer peer
remained connected; it was not interrupted. The Quest reported inactive/invalid
poses, so this is a transport observation, not physical-motion rendering validation.

| History: pose / input / body | Received pose / input / body, Hz | Median total payload, kB/s | Sender skips: pose / input / body |
| --- | --- | ---: | --- |
| 1 / 1 / 1 | 99.7 / 99.3 / 97.2 | 378 | 0 / 0 / 0 |
| 4 / 1 / 1 | 98.7 / 98.4 / 97.6 | 456 | 1 / 1 / 0 |
| 8 / 1 / 1 | 98.3 / 98.4 / 97.2 | 550 | 4 / 6 / 8 |
| 1 / 1 / 1 | 99.6 / 98.7 / 96.5 | 376 | 1 / 1 / 4 |
| 8 / 8 / 8 | 40.6 / 45.5 / 33.5 | 1031 | 716 / 654 / 791 |
| 1 / 1 / 1 | 99.8 / 99.8 / 97.8 | 382 | 0 / 0 / 0 |

Receive rates use raw recording phase boundaries; sender counters use the nearby
HTTP snapshots, and median payload rates summarize the last ten seconds. These
windows differ slightly. Animation-frame P95 stayed at 16.7–16.8 ms throughout.
With all histories at 8, pose-arrival P95 rose to 58.2 ms and its maximum to
143.5 ms. Message callback P95 remained at or below 0.5 ms.

The sender does **not** wait for history to fill. `packet()` includes the newest
available samples up to the requested maximum, and a regression test now verifies
immediate publication of one and then two samples with history 8 requested.
The measured slowdown is dominated by sender backpressure: all streams within a
connection share our 16,384-byte buffered-amount cutoff, while one history-8 body
packet in this capture is 18,424 bytes. This is an application cutoff, not a socket
buffer capacity. In the pinned `webrtc-sctp` 0.17.2 implementation, packetization
adds payload bytes to the stream's `buffered_amount`; processing SCTP selective
acknowledgements releases them. It therefore includes in-flight data awaiting
acknowledgement, not just unsent data. The check precedes sending and excludes the
next packet's size, so a single send can cross the cutoff. Subsequent publications
across that connection's streams are suppressed until the amount falls below it.
The bounded acquisition history remains separate, and peers read it without
removing samples. Skips do not consume message numbers; the all-8 phase had only
0 / 3 / 8 sequence gaps despite the much larger number of skipped publications.

This reproduces uneven delivery under larger combined histories, but does not
establish the exact cause of the earlier pose-only hiccups. No send-buffer policy
was changed in this checkpoint; increasing its size alone could trade skipped
publications for greater latency. Physical-motion and hardware-GPU validation
remain outstanding. Browser checks passed with both this Quest and the synthetic
source, including continuous/dirty rendering, slow consumption, and exact agreement
between recorded payload bytes and the rolling transfer totals.

Local evidence: `.artifacts/history/quest-probe.json` (server counters and charts),
`quest-capture.json` (decoded packet analysis), `quest-panel.png`, and recording
`.artifacts/recordings/cb10f570-ff71-4cdc-93c6-464017f6772d.jsonl`.

## Acquisition and display defaults, 2026-11-05

Acquisition now runs at 200 Hz. Publication defaults to 100 Hz with up to two
samples per message, and the Viewer offers 200 Hz publication and history length
2 alongside the existing options. Missing startup history is still sent
immediately. One display animation callback consumes the latest pending samples,
applies scene changes, then renders. Continuous rendering is enabled by default;
fixed-rate consumers and dirty-only rendering remain available for investigation.

The Android APK was built and deployed to the Quest over USB ADB. An unattended
Viewer connected over Wi-Fi and observed each configuration for roughly 12 seconds
after settling. All streams reported 200 Hz acquisition and history length 2.
Rates calculated from sample numbers and acquisition timestamps were approximately
200 Hz throughout; this measures polling, not independent sensor updates at 200 Hz.

| Requested pose / input / body, Hz | Received pose / input / body, Hz | Sender skips: pose / input / body |
| --- | --- | --- |
| 100 / 100 / 100 | 96.4 / 98.3 / 97.6 | 18 / 9 / 4 |
| 200 / 100 / 100 | 192.5 / 96.6 / 95.0 | 76 / 37 / 40 |
| 200 / 200 / 200 | 157.2 / 145.2 / 166.5 | 513 / 658 / 395 |
| 100 / 100 / 100 | 99.3 / 98.3 / 98.8 | 6 / 7 / 5 |

There were no send errors or malformed packets. Sequence gaps still occurred over
the unreliable transport. All-stream 200 Hz publication hits the existing cutoff,
so the requested rate remains a maximum rather than guaranteed throughput. The
cutoff policy is unchanged. Animation-frame P95 stayed at 16.7–16.8 ms, and the
display consumer applied approximately 58–60 updates per second. Body tracking was
active, but no physical-motion or controller-interaction qualification was made.

Synthetic two-peer tests measured approximately 100 Hz default delivery and 200 Hz
acquisition; a 200 Hz pose request delivered approximately 200 Hz. The 5 Hz consumer
coalesced updates without slowing the other peer. Fourteen Rust tests, clippy,
22 Viewer unit tests, the production build, and browser tracking/performance checks
passed, including display-driven consumption/rendering and WebGL failure handling.

Local evidence: `.artifacts/rates/quest.json`, `quest-capture.json`,
`quest-workspace.png`, `quest-performance.png`, and recording
`.artifacts/recordings/7e0dfb91-4562-413a-bc72-fe02ad36945e.jsonl`.
