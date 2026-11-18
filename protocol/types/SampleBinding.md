# SampleBinding

One selected sample and its representation within a subscription bundle.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `descriptor` | [SampleDescriptorIndex](SampleDescriptorIndex.md) | Selected advertised descriptor. |
| `format` | [SampleFormat](SampleFormat.md), `u8` | Format supported by that descriptor. |
| `reference_space` | [ReferenceSpace](ReferenceSpace.md), `u8` | Present only for a pose; selected advertised space. |

The descriptor belongs to the subscription's group.
Its kind determines the component count and whether `reference_space` is present.
A binding occupies six bytes for a pose and five bytes otherwise, without a placeholder byte.
Bindings preserve request order, including repeated selections.

Requirements: [PRO-0025](../../design/requirements/protocol/PRO-0025.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md).
