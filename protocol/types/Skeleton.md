# Skeleton

Associates live joint poses with their hierarchy and rest-pose sources.

| Field, in wire order | Encoding      | Meaning                               |
| -------------------- | ------------- | ------------------------------------- |
| `joints`             | `list<Joint>` | Non-empty list of [joints](Joint.md). |

Following parent references from every joint must reach a self-parented root.
Cycles involving distinct joints are invalid; multiple roots are allowed.
Descriptors may be shared by joints or skeletons, subject to unambiguous [parent-space resolution](ReferenceSpace.md#parent-space-resolution).

Requirements: [PRO-0017](../../design/requirements/protocol/PRO-0017.md).
