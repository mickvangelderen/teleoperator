# UnsubscribeRequest

Client-to-server control request to end one accepted subscription generation.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `subscription_id` | `u32` | Client-assigned subscription id. |
| `generation` | `u32` | Nonzero generation returned in [SubscriptionAccepted](SubscriptionAccepted.md). |

The pair identifies exactly which accepted subscription is being ended, including if the id has since been reused.
The server responds with [SubscriptionEnded](SubscriptionEnded.md) for this pair.
See [unsubscription](../interactions/06-unsubscription.md) and [control encoding](../encoding/control.md).

Source: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
