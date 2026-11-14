# SamplePublication

One server-to-client publication of an accepted subscription's selected samples.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Client-assigned id defining the selection. |
| `acquired_at` | [Instant](Instant.md) | Group acquisition time. |
| `predicted_for` | `Option<Instant>` | Actual time represented by all predicted samples, if present. |
| `availability` | Packed bitmap | One bit per selected sample in order. |
| `boolean_values` | Packed bitmap | Available bit values, in selection order. |
| `numeric_values` | Packed components | Available non-bit values, in selection and component order. |

The header occupies 20 bytes, followed by the sections in [publication encoding](../encoding/publication.md).
Delivery uses the accepted channel.
`predicted_for` is required when any available selected sample is predicted.
All predicted values in the publication represent that same actual time.
It is absent when no predicted samples are present.
It must not merely repeat a requested prediction target that the source did not actually use.
Both times use the [clock response](ClockResponse.md)'s clock and origin.

Requirements: [PRO-0028](../../design/requirements/protocol/PRO-0028.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0027](../../design/requirements/protocol/PRO-0027.md).
