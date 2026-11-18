# Publication

Server-to-client publication on the accepted subscription's channel.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Subscription defining the layout. |
| `acquired_at` | [Instant](Instant.md) | Common acquisition time of included values. |
| `predicted_for` | `Option<Instant>` | Actual sample target time returned by the device, if available. |
| `sequence_number` | Selected [sequence representation](SequenceNumberFormat.md) | Present only when a sequence format is configured. |
| `presence` | Bitmap | One bit per bundle after bundle 0, in bundle order. |
| `samples` | Encoded bundles | Complete values for each present bundle in order. |

Bundle 0 is always included and has no presence bit.
A zero presence bit means that bundle is omitted, not that its samples are invalid or zero.
Within each included bundle, all selected values are present.
See [publication encoding](../encoding/publication.md) and [values and quality](../interactions/04-publication.md#values-and-quality).

`predicted_for` reports source information, never just the requested target.
It is absent when the device supplies no actual target time, including when prediction is used but its target is unavailable.
A present target applies to all target-dependent values in this publication; a server cannot combine conflicting source targets into one publication.
Both timestamps use the connection's server clock and origin.

Requirements: [PRO-0028](../../design/requirements/protocol/PRO-0028.md), [PRO-0027](../../design/requirements/protocol/PRO-0027.md).
