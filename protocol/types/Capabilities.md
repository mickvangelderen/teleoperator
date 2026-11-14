# Capabilities

Server-to-client advertisement on the reliable channel after version selection.

| Field, in wire order | Encoding                 | Meaning                                    |
| -------------------- | ------------------------ | ------------------------------------------ |
| `sample_groups`      | `list<SampleGroup>`      | [Acquisition groups](SampleGroup.md).      |
| `sample_descriptors` | `list<SampleDescriptor>` | [Selectable samples](SampleDescriptor.md). |
| `skeletons`          | `list<Skeleton>`         | [Joint mappings](Skeleton.md).             |

References in the advertisement and subsequent subscriptions use these lists.
See [capability advertising](../interactions/02-capabilities.md).

Requirements: [PRO-0016](../../design/requirements/protocol/PRO-0016.md).
