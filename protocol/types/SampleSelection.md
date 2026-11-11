# SampleSelection

One requested sample representation within a [SubscriptionRequest](SubscriptionRequest.md).

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `descriptor` | `u32` | Zero-based index into [Capabilities.sample_descriptors](Capabilities.md). |
| `format` | [SampleFormat](SampleFormat.md), `u8` | One of the descriptor's advertised formats. |
| `reference_space` | `u8` | Advertised [ReferenceSpace](ReferenceSpace.md) for a pose; `0` meaning absent for all other kinds. |

For a pose, `reference_space == 0` is invalid.
For a non-pose sample, a nonzero reference space is invalid.
The absent marker is not a valid `ReferenceSpace` value.
This fixed six-byte selection layout allows a server to read and reject unknown descriptor indices without needing their kind.

The descriptor MUST belong to the request's group, and its kind determines the component count.
The selected format applies to every component.
See [primitive encoding](../encoding/primitives.md).

Sources: [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
