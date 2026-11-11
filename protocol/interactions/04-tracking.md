# Tracking publication

Each [TrackingPacket](../types/TrackingPacket.md) contains one acquisition of the selected group: subscription id, generation, acquisition timestamp, availability, and current values.
Every packet MUST be decodable using only the accepted subscription and advertised capabilities.
No delta state, previous packet, acknowledgement, or recovery packet is needed.

## Receiving a packet

1. Find the active accepted subscription matching both id and generation.
2. If there is no match, discard the packet, including packets that overtake acceptance on control.
3. Decode and validate the complete packet using [tracking encoding](../encoding/tracking.md).
4. Discard a packet whose acquisition timestamp is less than or equal to the last delivered timestamp for that generation.
5. Deliver the current availability and values and remember its timestamp.

Do not wait for a missing timestamp or for a packet with an older generation.
Initialize timestamp comparison separately for each accepted generation.
Packets for different subscriptions can share a timestamp when they describe the same acquisition.

## Availability

Availability is reported separately for every selected sample on every acquisition.
An available zero, `false`, centered thumbstick, released trigger, or zero counter is valid data.
An unavailable value has no payload and MUST NOT be interpreted as a zero or as a newly observed copy of its previous value.
For poses, availability covers the full position and orientation; a partially valid pose is unavailable as a whole.
Other selected values in the same packet remain usable.

## Edge counters

Press, release, touch, and untouch counters are cumulative and maintained independently of subscriptions, including when no client selects them.
Subscribing, replacing, or unsubscribing MUST NOT reset these counters.
Implementations SHOULD use native device transition reporting when available instead of inferring every transition from sampled states.
An observed edge increments its corresponding counter, which wraps at the selected unsigned width.
Representations of the same counter expose its count modulo their respective widths.

A client's first available counter value establishes a baseline.
For an unsigned counter with width `w`, the observed difference is `(current - previous) mod 2^w`.
The exact number of edges is recoverable only when fewer than `2^w` increments occurred between the two observations.
For example, a `u8` transition from `254` to `1` represents three edges modulo `256`.
Loss of intermediate tracking packets does not prevent decoding the current cumulative value.

An unavailable counter MUST NOT update the baseline.
After a gap, the same modulo limit applies to the interval since the last available value.
If a device counter resets or loses continuity, the server MUST end affected subscriptions with a reason before publishing reset values under new subscriptions.
New accepted generations establish fresh baselines.

Sources: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0008](../../design/requirements/protocol/PRO-0008.md), [PRO-0010](../../design/requirements/protocol/PRO-0010.md), and [PRO-0012](../../design/requirements/protocol/PRO-0012.md).
