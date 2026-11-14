# UnsubscribeRequest

Client-to-server reliable request to end an accepted subscription.

| Field, in wire order | Encoding | Meaning                          |
| -------------------- | -------- | -------------------------------- |
| `subscription_id`    | `u32`    | Client-assigned id.              |
| `generation`         | `u32`    | Accepted generation being ended. |

The generation distinguishes this request from operations on a replacement using the same id.
See [unsubscription](../interactions/06-unsubscription.md).

Requirements: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
