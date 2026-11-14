# Operator binding

This page defines the current operator's WebRTC and source-quality policies, not requirements for every protocol server.

## WebRTC

One binary RTCDataChannel message contains one complete [protocol message](../encoding/messages.md).
The reliable channel is ordered with reliable delivery; the unreliable channel is unordered with zero retransmissions.
The pinned Rust callback receiver limits a message to 65,535 bytes, including its protocol tag.
Both peers enforce that binding limit and any smaller negotiated peer message limit before sending; subscription admission checks the fixed publication size on either channel.
The complete capability advertisement must also fit. An oversize message is rejected, not split into application chunks.
Buffered-byte backpressure is a separate resource policy.

## Source quality

The operator uses ordinary descriptors and selected samples to distinguish inactive representations from measurements:

- **Poses:** inactive or invalid position components encode `(0, 0, 0)` with position-valid and position-tracked false; inactive or invalid orientation encodes the identity quaternion with orientation-valid and orientation-tracked false. A valid component is preserved independently of the other component. Numeric normalization and exported quality must agree; an unrepresentable component must not be marked valid.
- **Input actions:** each actual action has a generic `bit` sample whose id is its unique published value id followed by `/active`. Descriptor descriptions identify the companion value and counters. True means the action is active and its value can be represented in its advertised kind. False means its boolean/scalar/vector value is a false/zero placeholder, not a measured release or center. Cumulative edge counters keep their actual counts; inactivity and reactivation do not manufacture edges. Actions sharing an OpenXR component path still have distinct published action ids and activity samples.
- **Body tracking:** absent or inactive body tracking gives invalid live joint components and false quality fields. Rest geometry and revision retain the latest validated skeleton together, including after a revision change; they are retained definitions, not fabricated live measurements. A malformed present body layout is a source-contract error.
- **Confidence:** the validity companion is a generic `bit` named by appending `/valid` to the confidence descriptor's id (`/body/FB/confidence/valid` for this operator). It is true only when an active body supplies usable finite confidence in `[0, 1]`. Otherwise the confidence value is a zero placeholder and this bit is false. A measured confidence of zero has the bit true. When this companion is advertised, a client needs a current true value to interpret the number as measured confidence; an unselected or missing companion does not establish validity. Servers without this convention retain ordinary confidence semantics.

These status samples have no new wire kind or descriptor field. Clients can discover and display them as ordinary samples; no device path must be built into a generic viewer and no status selection is hidden or automatic.
For its confidence summary, the viewer requires the advertised companion to be in the same acquisition group and have the same acquisition timestamp as the numeric value. Separately delivered status that has not reached a matching acquisition leaves confidence unknown.
An inactive controller or body does not end a combined subscription whose values remain representable under this policy.
Missing expected action/pose slots, malformed selected source structure or an encoding failure rejects a known-unfulfillable request or ends only affected existing subscriptions; rejection leaves a replacement's old subscription intact.
Until the first acquisition exists, publication waits. Repeated publications of a cached acquisition retain its original acquisition timestamp.

The existing Quest acquisition target remains unchanged. `predicted_for` reports the source's actual target contract, not an assertion that the requested consumption delay changed native prediction or that native returned-time accuracy was measured.
