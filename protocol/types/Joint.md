# Joint

References a parent and live and rest-pose sample descriptors.

| Field, in wire order | Encoding                                          | Meaning                                           |
| -------------------- | ------------------------------------------------- | ------------------------------------------------- |
| `parent`             | [JointIndex](JointIndex.md)                       | Parent joint; a self-reference identifies a root. |
| `pose_sample`        | [SampleDescriptorIndex](SampleDescriptorIndex.md) | Joint's live pose descriptor.                     |
| `rest_pose_sample`   | [SampleDescriptorIndex](SampleDescriptorIndex.md) | Joint's rest-pose descriptor.                     |

Both sample references identify descriptors of kind `pose`.
The parent is a joint in this skeleton; only a self-parent identifies a root.

Requirements: [PRO-0018](../../design/requirements/protocol/PRO-0018.md).
