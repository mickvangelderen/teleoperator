# UpdateSchedule

Client-to-server reliable update to an existing subscription's publication timing.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Subscription to update. |
| `interval` | [Duration](Duration.md) | Positive interval between scheduled slots. |
| `phase` | [Duration](Duration.md) | Phase relative to the server clock origin, modulo interval. |
| `prediction_offset` | [Duration](Duration.md) | Desired prediction offset from a scheduled slot. |

The payload occupies 28 bytes.
All three timing fields replace their previous values together.
The update preserves bundles, channel, sequence numbering and acknowledgment state and has no response message.
A structurally valid update to an unknown or ended id is ignored because termination can race a queued update.
Invalid durations or a zero interval are malformed reliable control and end the connection, even for an unknown id.
If a valid update exceeds server admission limits, the server terminates the subscription with an explanation.
See [live schedule changes](../interactions/08-scheduling.md#live-schedule-changes).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
