# Subscribe

Client-to-server reliable request to create or fully replace a subscription.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Client-chosen id. |
| `group` | [SampleGroupIndex](SampleGroupIndex.md) | Acquisition group containing every binding. |
| `channel` | [Channel](Channel.md), `u8` | Publication channel. |
| `interval` | [Duration](Duration.md) | Positive interval between scheduled publication slots. |
| `phase` | [Duration](Duration.md) | Phase relative to the server clock origin, modulo interval. |
| `prediction_offset` | [Duration](Duration.md) | Desired prediction offset from the scheduled publication time. |
| `sequence_number_format` | [Option<SequenceNumberFormat>](SequenceNumberFormat.md) | Sequence representation, or absent. |
| `bundles` | `list<list<SampleBinding>>` | Non-empty ordered list of bundles of [bindings](SampleBinding.md). |

Bundle indices are their positions in `bundles`.
Bundle 0 is always included and may be empty.
Bundles 1 onward publish their latest state until acknowledged; their presence requires a sequence format.
With only bundle 0, a sequence format is optional.
A slot sends no publication when bundle 0 is empty and no other bundle is pending.
Phase and prediction offset may be zero; phase may exceed interval.

Changing only `interval`, `phase` or `prediction_offset` uses [UpdateSchedule](UpdateSchedule.md).
Changing any other field requires a complete request.
See [subscription](../interactions/03-subscription.md) and [replacement](../interactions/05-replacement.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0025](../../design/requirements/protocol/PRO-0025.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
