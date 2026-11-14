# SampleSelection

A sample and representation selected by a subscription.

| Field, in wire order | Encoding                                          | Meaning                                                                         |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `descriptor`         | [SampleDescriptorIndex](SampleDescriptorIndex.md) | Selected sample.                                                                |
| `format`             | [SampleFormat](SampleFormat.md), `u8`             | Advertised encoding format.                                                     |
| `reference_space`    | `u8`                                              | Advertised [ReferenceSpace](ReferenceSpace.md) for a pose; `0` for other kinds. |

The encoding is six bytes.
The descriptor belongs to the request's group and its kind determines the component count.

Requirements: [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
