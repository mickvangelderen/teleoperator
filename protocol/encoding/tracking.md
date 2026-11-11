# Tracking wire format

Every transport message contains exactly one [TrackingPacket](../types/TrackingPacket.md).
The packet boundary comes from the transport, without an additional length prefix.

## Header

| Byte offset | Bytes | Field |
| --- | --- | --- |
| 0 | 4 | `subscription_id`, `u32`. |
| 4 | 4 | `generation`, `u32`. |
| 8 | 8 | `acquired_at_ns`, `u64`. |
| 16 | Variable | Availability, boolean values, then numeric values. |

All fixed-width values are [little-endian](primitives.md).
The accepted request determines the selected samples, formats, spaces, and component counts.

## Availability section

Let `N` be the number of selections in the accepted request.
The first payload section occupies `ceil(N / 8)` bytes.
Bit `i` is `1` if selection `i` has a valid current value, and `0` if it is missing or inactive.
An unavailable selection contributes no boolean or numeric value bytes.

Every packet has a complete availability bitmap.
A missing value has no implicit relationship to its value in an earlier packet.
An all-unavailable acquisition is represented by a zero availability bitmap with no following value sections.

## Boolean section

Collect the available selections whose format is `bit`, preserving request order.
Let `B` be their count.
Their values occupy `ceil(B / 8)` bytes, packed from bit zero in this filtered order.
No bit slot is retained for an unavailable boolean selection.
The section is empty when `B == 0`.

Availability and boolean values are separate: an available `false` has availability `1` and value `0`.
Unused high bits of the final byte in each bitmap MUST be zero.

## Numeric section

Walk selections in request order, skipping unavailable selections and those with format `bit`.
Write each remaining sample's components consecutively in the order specified by its [SampleKind](../types/SampleKind.md), using its selected [SampleFormat](../types/SampleFormat.md).
There are no per-value tags, lengths, alignment bytes, or sample ids.
A pose with format `f32` contributes exactly 28 bytes; a thumbstick with format `snorm8` contributes two bytes.

The packet length MUST equal:

```text
16 + ceil(N / 8) + ceil(B / 8)
   + sum(component_count[i] * component_width_bytes[i]
         for each available non-bit selection i)
```

The maximum packet size for subscription admission uses all selections available.
Because availability can vary, packet length is not constant even though the accepted layout is immutable.

## Validation and freshness

Packets shorter than the header, incorrect payload lengths, nonzero bitmap padding, and invalid kind-specific values are malformed and discarded.
Validate the full packet before exposing any of its values or advancing its timestamp baseline.
Use the complete `(subscription_id, generation)` pair to look up the layout.
Unknown or retired generations are discarded without attempting to decode their payload.
After validation, timestamps less than or equal to the last delivered timestamp for that generation are discarded.

A later valid packet can always be consumed without an earlier tracking packet.
Counter differences are optional interpretation of cumulative values; previous counter observations are not needed to decode the packet itself.

Sources: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0010](../../design/requirements/protocol/PRO-0010.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
