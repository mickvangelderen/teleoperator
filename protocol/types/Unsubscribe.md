# Unsubscribe

Client-to-server reliable request to end a subscription.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Client-assigned id to end. |

See [unsubscription](../interactions/06-unsubscription.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
