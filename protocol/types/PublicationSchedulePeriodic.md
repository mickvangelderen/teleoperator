# PublicationSchedulePeriodic

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `interval` | [Duration](Duration.md) | Desired interval between publications; greater than zero. |
| `phase` | [Duration](Duration.md) | Desired phase relative to the server clock origin. |
| `consumption_delay` | [Duration](Duration.md) | Expected interval from scheduled publication to consumption. |

Phase is interpreted modulo interval; a phase greater than or equal to interval is valid.
Phase and consumption delay can be zero.
The payload occupies 24 bytes.
See [scheduling and prediction](../interactions/08-scheduling.md).

Requirements: [PRO-0026](../../design/requirements/protocol/PRO-0026.md), [PRO-0029](../../design/requirements/protocol/PRO-0029.md).
