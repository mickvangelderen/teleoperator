# UpdateSchedule

Client-to-server reliable update to an existing subscription's publication timing.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Id of the subscription to update. |
| `schedule` | [PublicationSchedule](PublicationSchedule.md) | Complete replacement schedule. |

The update leaves the selection and channel unchanged and has no response message.
The server applies valid updates in reliable receive order.
An update to an unknown or ended id is ignored because termination can race a queued update.
An invalid schedule is malformed reliable control and ends the connection.
See [live schedule changes](../interactions/08-scheduling.md#live-schedule-changes).

The message name and tag make the live schedule change required by PRO-0024 concrete; they add no separate acknowledgment mechanism.

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
