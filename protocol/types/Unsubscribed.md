# Unsubscribed

Server-to-client reliable notification that a subscription has ended.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Client-assigned id. |
| `reason` | `string` | Explanation of the termination. |

See [unsubscription](../interactions/06-unsubscription.md) and [replacement](../interactions/05-replacement.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
