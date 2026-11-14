# SubscriptionRequest

Client-to-server request on the reliable channel to create or replace a subscription.

| Field, in wire order  | Encoding                                | Meaning                                                    |
| --------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `subscription_id`     | `u32`                                   | Client-assigned id.                                        |
| `group`               | [SampleGroupIndex](SampleGroupIndex.md) | Selected acquisition group.                                |
| `delivery_mode`       | [DeliveryMode](DeliveryMode.md), `u8`   | Channel for sample publications.                           |
| `publication_rate_hz` | `f32`                                   | Finite, positive requested publication frequency.          |
| `samples`             | `list<SampleSelection>`                 | Non-empty list of [sample selections](SampleSelection.md). |

Request order defines publication value order.
An accepted request using an active id replaces that subscription.
See [subscription](../interactions/03-subscription.md).

Requirements: [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md).
