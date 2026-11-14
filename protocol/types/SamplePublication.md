# SamplePublication

One server-to-client publication of an accepted subscription's selected samples.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Client-assigned id defining the selection. |
| `acquired_at` | [Instant](Instant.md) | Group acquisition time. |
| `predicted_for` | `Option<Instant>` | Actual time represented by all predicted samples, if present. |
| `boolean_values` | Packed bitmap | All selected bit values, in selection order. |
| `numeric_values` | Packed components | All selected non-bit values, in selection and component order. |

The header occupies 20 bytes, followed by the sections in [publication encoding](../encoding/publication.md).
Delivery uses the accepted channel.
Every selected value is present; status is expressed through ordinary samples as described in [values and quality](../interactions/04-publication.md#values-and-quality).
`predicted_for` is required when any selected sample represents a predicted value.
All predicted values in the publication represent that same actual time.
It is absent when no predicted samples are present.
It must not merely repeat a requested prediction target that the source did not actually use.
Both times use the [clock response](ClockResponse.md)'s clock and origin.

Requirements: [PRO-0028](../../design/requirements/protocol/PRO-0028.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0027](../../design/requirements/protocol/PRO-0027.md).
