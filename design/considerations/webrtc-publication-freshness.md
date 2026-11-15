# Fresh WebRTC publications and send queue progress

## Goal

Send the freshest available sample for each subscription when the transport can
consume it. Keep at most one replaceable, wholly unsent publication per
subscription: a newer acquisition supersedes that pending value. Allow multiple
publications to be in flight; waiting for an acknowledgment before submitting the
next sample would unnecessarily make throughput depend on round-trip time.

An eligible acquisition, a clock request, or transport send progress should wake
the sender. When a sample is already available and eligible for publication, an
additional publication timer should not delay it. Requested rate limits and
explicit scheduling constraints still need to be respected. Clock replies should
be serviced promptly and stamped as close to submission as possible.

The useful signal is which message, or which part of the pending queue, the
transport has consumed. Aggregate writability alone does not identify obsolete
publications that are still waiting to be transmitted.

## Possible implementation

Keep the latest sample or a reference to it per subscription, and serialize it
when the transport is ready to consume that subscription's next publication.
Alternatively, let the transport replace a wholly unsent message by an
application-provided subscription key. Expiry should include time spent waiting
in the queue, and stale messages should be discarded before their first
transmission whenever possible.

Once transmission of a fragmented message has started, its remaining fragments
cannot be overwritten with a new sample. Finish that message or abandon it using
SCTP's partial-reliability mechanism. Message consumption, expiration, and peer
acknowledgment are separate events; expose them separately to the application.

## Prior art in Google dcSCTP

Google's native dcSCTP API accepts a per-message `SendOptions::lifetime` and an
application-selected `lifecycle_id`. Its callbacks distinguish:

| Callback | Meaning |
| --- | --- |
| `OnLifecycleMessageFullySent(id)` | The last fragment has left the SCTP send queue for transmission. This occurs once, independently of retransmissions. |
| `OnLifecycleMessageExpired(id, maybe_delivered)` | The message expired. `maybe_delivered` distinguishes possible delivery from a message whose unsent data prevented complete delivery. |
| `OnLifecycleMessageDelivered(id)` | The peer cumulatively acknowledged the message. |
| `OnLifecycleEnd(id)` | No further lifecycle callbacks will occur for this message. |

This is a useful precedent for identifying consumed messages without waiting for
acknowledgments. These are native SCTP interfaces, not JavaScript
`RTCDataChannel` methods. The API does not itself establish a policy for replacing
queued publications by subscription. See the
[dcSCTP public header](https://webrtc.googlesource.com/src.git/+/refs/heads/main/net/dcsctp/public/dcsctp_socket.h).

## Current implementation and upstream support

The operator uses `webrtc` 0.21.1 with its `rtc` core pinned to upstream commit
`70901c3df6ad92dcb87d97af3d1e2fa8a2e2ae38`. The published core ignores the reliability
settings of remotely opened channels; the pin includes the fix from
[rtc PR 280](https://github.com/webrtc-rs/rtc/pull/280). Replace the pin with a
published release once it includes that fix. This core caps individual messages
at 256 KiB, and the operator also respects a smaller limit advertised by the peer.

Publications still follow the existing subscription schedule. Each selected
snapshot is serialized before checking the channel's outstanding bytes. Several
publications from one subscription can be queued; when the guard rejects a new publication,
older messages already submitted to SCTP remain there. Clock replies share the
unreliable channel and its capacity guard.

The upgrade uses `outstanding_bytes()` for those guards. It includes bytes in the
application-to-SCTP pipeline and bytes awaiting acknowledgment or abandonment.
It does not identify individual messages consumed for transmission. Upstream also
provides configurable buffer limits, `writable()`, and `try_send()`; these address
aggregate backpressure rather than replacement of unsent state. See
[webrtc PR 817](https://github.com/webrtc-rs/webrtc/pull/817).

Upstream fixed the failure to include pending-queue time in `maxPacketLifeTime` in
the 0.21 release line, following
[rtc issue 232](https://github.com/webrtc-rs/rtc/issues/232) and
[PR 233](https://github.com/webrtc-rs/rtc/pull/233). Our unreliable channel currently
uses `maxRetransmits: 0` and no lifetime, so upgrading alone does not enable timed
expiry or the freshness policy above. The remaining work is a transport hook for
per-message consumption or obtaining the latest publication at dequeue time, plus
replacement or expiry of obsolete unsent state.
