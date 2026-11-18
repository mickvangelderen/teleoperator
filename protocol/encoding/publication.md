# Publication encoding

Both channels carry the same [Publication](../types/Publication.md) payload with tag `0x09`.
Offsets below exclude that one-byte tag.

| Offset | Bytes | Field |
| ------ | ----- | ----- |
| 0 | 4 | `subscription_id`, `u32`. |
| 4 | 8 | `acquired_at`, [Instant](../types/Instant.md). |
| 12 | 8 | `predicted_for`, `Option<Instant>`. |
| 20 | S | Optional sequence number; S is 0, 2, 4 or 8. |
| 20 + S | P | Bundle presence bitmap; P is `ceil((bundle_count - 1) / 8)`. |
| 20 + S + P | Variable | Included bundles, in increasing bundle index order. |

Presence bit `j - 1` selects bundle `j` for `j >= 1`.
Bundle 0 is always included.
The accepted subscription supplies all counts, formats and component counts; none are repeated in a publication.
All included values come from the acquisition identified by `acquired_at`.
An omitted bundle contributes no bytes and is not needed to decode any included bundle.

## Bundle values

Encode each included bundle independently:

1. Pack its `bit` bindings in binding order, using `ceil(B / 8)` bytes for B bits.
2. Append its non-bit bindings in binding order, with components in [SampleKind](../types/SampleKind.md) order and [SampleFormat](../types/SampleFormat.md) encoding.

Each bundle starts at a byte boundary; bits from different bundles never share a byte.
There are no per-sample absence bits, identifiers, counts or lengths.
An empty bundle contributes zero bytes.
A false value occupies its bit with value zero, and an f32 pose occupies 28 bytes.
All bitmaps are least-significant-bit first; unused high bits in their last byte are ignored.

The exact body length is:

```text
20 + S + ceil((bundle_count - 1) / 8)
   + sum(ceil(bit_bindings[j] / 8)
         + sum(component_count[i] * component_width_bytes[i]
               for each non-bit binding i in bundle j)
         for each included bundle j)
```

Admission checks the maximum message size with every bundle present, including the tag.
A publication's length varies only with its presence bitmap.

## Validation

Resolve the accepted subscription by id before decoding its layout.
Discard unknown or retired ids, wrong-channel publications, invalid required times, incorrect lengths and invalid sample values.
Validate the complete publication before exposing any values or acknowledging it.
Padding bits in both presence and value bitmaps do not affect length or semantics.

Requirements: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md).
