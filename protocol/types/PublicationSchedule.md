# PublicationSchedule

Desired timing of a subscription's publications, independent of its channel.

| Variant | `u8` tag | Payload |
| ------- | -------- | ------- |
| `Periodic` | `0x01` | [PublicationSchedulePeriodic](PublicationSchedulePeriodic.md). |
| `OnChange` | `0x02` | None. |

The tag is followed immediately by the variant's payload.
Other tags are invalid in version 1.
Periodic occupies 25 bytes; OnChange occupies one byte.
OnChange publishes when a selected value or its availability changes.
See [publication timing](../interactions/08-scheduling.md).

Requirements: [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
