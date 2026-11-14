# SubscriptionRejected

Server-to-client reliable response rejecting the outstanding request for an id.

| Field, in wire order | Encoding | Meaning                     |
| -------------------- | -------- | --------------------------- |
| `subscription_id`    | `u32`    | Id from the request.        |
| `reason`             | `string` | Human-readable explanation. |

The response leaves an existing subscription unchanged.
See [subscription](../interactions/03-subscription.md).

Requirements: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
