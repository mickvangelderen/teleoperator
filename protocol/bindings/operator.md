# Operator binding

This page defines the current operator's WebRTC and source-quality policies, not requirements for every protocol server.

## WebRTC

For [endpoint discovery](../overview.md#endpoint-discovery), the instance's SRV target and port identify the HTTP signaling listener that accepts `POST /offer`.
The WebRTC data channels use a separately negotiated UDP path.

One binary RTCDataChannel message contains one complete [protocol message](../encoding/messages.md).
The reliable channel is ordered with reliable delivery; the unreliable channel is unordered with zero retransmissions.
Receiver resource bounds are directional and independent of transport send capacity.
Each sender enforces the destination's configured bound, its transport's actual message limit and any smaller negotiated peer limit.
These are deployment limits rather than protocol-wide constants.
Subscription admission checks the maximum publication size with all bundles present on either channel.
The complete capability advertisement must also fit.
An oversize message is rejected, not split into application chunks.
WebRTC handles fragmentation and reassembly and delivers complete messages to the protocol decoder.
Buffered-byte backpressure is a separate resource policy.

## Source quality

The operator uses ordinary descriptors and selected samples to distinguish inactive representations from measurements:

- **Poses:** inactive or invalid position components encode `(0, 0, 0)` with position-valid and position-tracked false; inactive or invalid orientation encodes the identity quaternion with orientation-valid and orientation-tracked false.
  A valid component is preserved independently of the other component.
  Numeric normalization and exported quality must agree; an unrepresentable component must not be marked valid.
- **Input actions:** each actual action has a generic `bit` sample whose id is its unique published value id followed by `/active`.
  Descriptor descriptions identify the companion value and counters.
  True means the action is active and its value can be represented in its advertised kind.
  False means its boolean/scalar/vector value is a false/zero placeholder, not a measured release or center.
  Cumulative edge counters keep their actual counts; inactivity and reactivation do not manufacture edges.
  Actions sharing an OpenXR component path still have distinct published action ids and activity samples.
- **Body tracking:** absent or inactive body tracking gives invalid live joint components and false quality fields.
  Rest geometry and revision retain the latest validated skeleton together, including after a revision change; they are retained definitions, not fabricated live measurements.
  A malformed present body layout is a source-contract error.
- **Confidence:** the validity companion is a generic `bit` named by appending `/valid` to the confidence descriptor's id (`/body/FB/confidence/valid` for this operator).
  It is true only when an active body supplies usable finite confidence in `[0, 1]`.
  Otherwise the confidence value is a zero placeholder and this bit is false.
  A measured confidence of zero has the bit true.
  When this companion is advertised, a client needs a current true value to interpret the number as measured confidence; an unselected or missing companion does not establish validity.
  Servers without this convention retain ordinary confidence semantics.

These generic status samples have no typed descriptor association with their companion values.
Interpreting `/active` and `/valid` requires knowledge of this binding's naming convention; the base protocol alone does not supply device-independent validity inference for them.
Clients without that knowledge can treat them only as ordinary generic samples.
To qualify a numeric confidence value under this binding, its advertised companion must belong to the same acquisition group and carry a matching acquisition timestamp with value true.
An omitted, unselected or mismatched companion does not establish measured confidence.
Select related values together when a common acquisition is required; selection does not implicitly add companions.
An inactive controller or body does not end a combined subscription whose values remain representable under this policy.
Missing expected action/pose slots, malformed selected source structure or an encoding failure rejects a known-unfulfillable request or ends only affected existing subscriptions; rejection leaves a replacement's old subscription intact.
Until the first acquisition exists, publication waits.
Repeated publications of a cached acquisition retain its original acquisition timestamp.

`predicted_for` reports the device's actual returned target when available; otherwise it is absent.
The requested prediction offset does not establish native prediction behavior or measured timestamp accuracy.

## Publication implementation guidance

Use a sequence format for acknowledged bundles; u32 is a practical client default.
Keep a bounded sent-publication history and clear only matching current bundle states on exact acknowledgments.
Repeated pending bundles use fresh sequences and the latest acquisition, respecting scheduled slots.
The transport freshness [consideration](../../design/considerations/webrtc-publication-freshness.md) discusses replacing wholly unsent work and send-progress callbacks; it does not add a wire field, acknowledgment barrier or required transport API.
