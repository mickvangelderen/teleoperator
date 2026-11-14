# SubscriptionEnded

Server-to-client reliable notification that a subscription generation has ended.

| Field, in wire order | Encoding | Meaning                     |
| -------------------- | -------- | --------------------------- |
| `subscription_id`    | `u32`    | Client-assigned id.         |
| `generation`         | `u32`    | Generation being ended.     |
| `reason`             | `string` | Human-readable explanation. |

The client retires the indicated generation.
See [unsubscription](../interactions/06-unsubscription.md) and [replacement](../interactions/05-replacement.md).

Requirements: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
