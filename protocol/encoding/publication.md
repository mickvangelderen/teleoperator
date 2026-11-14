# Sample publication encoding

Both channels carry the same [SamplePublication](../types/SamplePublication.md) body as the payload of tag `0x09`.
[Message encoding](messages.md) adds one tag byte on either channel.

## Header

| Offset | Bytes    | Field                                         |
| ------ | -------- | --------------------------------------------- |
| 0      | 4        | `subscription_id`, `u32`.                     |
| 4      | 8        | `acquired_at`, [Instant](../types/Instant.md). |
| 12     | 8        | `predicted_for`, `Option<Instant>`.            |
| 20     | Variable | Boolean values, numeric values.               |

The accepted request supplies the sample count, value order, formats and component counts.
The body is independently decodable from that context.

Every selected sample contributes its complete value representation; there is no availability bitmap or omitted value.
All values come from the group's identified acquisition.
Predicted values represent the actual common time in `predicted_for`, which is absent when no predicted samples are present.

## Boolean values

Collect selections using format `bit`, in request order.
For `B` such values, write `ceil(B / 8)` bytes in that order.
A false value occupies its bit with value zero.

## Numeric values

Write each non-bit sample in request order, with components in [SampleKind](../types/SampleKind.md) order and the selected [SampleFormat](../types/SampleFormat.md).
A pose encoded as `f32` occupies 28 bytes.
No per-value identifiers, lengths or padding are present.

The body length is exactly:

```text
20 + ceil(B / 8)
   + sum(component_count[i] * component_width_bytes[i]
         for each non-bit selection i)
```

The bitmap uses least-significant-bit-first order. Receivers MUST ignore unused high bits in the last byte.
The fixed size depends only on the accepted selection.
On either channel, the publication including its tag must fit the transport message limit and implementation resource limits.

## Validation

Use `subscription_id` to obtain the accepted layout.
Discard unknown or retired ids before decoding values.
For an accepted id, the selected channel, exact length and kind-specific numeric rules must be valid before exposing any values.
A malformed publication is discarded as a unit.

The [complete-value policy](../interactions/04-publication.md#values-and-quality) and [derivation](../derivation.md#feedback-overrides) explain the change from the earlier absence-aware requirements.

Requirements: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md).
