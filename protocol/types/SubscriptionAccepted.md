# SubscriptionAccepted

Server-to-client reliable response accepting the outstanding Subscribe request for an id.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Id from the accepted request. |

The client binds the complete pending request to this id and initializes its per-bundle receive state.
See [replacement](../interactions/05-replacement.md) for the limits of id reuse.

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
