# SampleSelectionEntry

One selected sample and its representation.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `descriptor` | [SampleDescriptorIndex](SampleDescriptorIndex.md) | Selected advertised descriptor. |
| `format` | [SampleFormat](SampleFormat.md), `u8` | Format supported by that descriptor. |
| `reference_space` | [ReferenceSpace](ReferenceSpace.md), `u8` | Present only for a pose; selected advertised space. |

The referenced descriptor's kind determines whether `reference_space` is present and the sample's component count.
The entry occupies six bytes for a pose and five bytes for any other kind.
There is no placeholder byte for a non-pose entry.
The descriptor belongs to the containing selection's group.

Requirements: [PRO-0025](../../design/requirements/protocol/PRO-0025.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md).
