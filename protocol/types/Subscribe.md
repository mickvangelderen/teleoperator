# Subscribe

Client-to-server reliable request to create or fully replace a subscription.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Client-chosen id. |
| `selection` | [SampleSelection](SampleSelection.md) | Group, sample order and representations. |
| `channel` | [Channel](Channel.md), `u8` | Channel used for publications. |
| `schedule` | [PublicationSchedule](PublicationSchedule.md) | Initial publication timing. |

An accepted request using an active id fully replaces that subscription.
Changing selection or channel requires a full request.
Changing only timing uses [UpdateSchedule](UpdateSchedule.md).
See [subscription](../interactions/03-subscription.md) and the unordered-packet limitation in [replacement](../interactions/05-replacement.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0025](../../design/requirements/protocol/PRO-0025.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
