# SubscriptionAccepted

Server-to-client reliable response accepting the outstanding Subscribe request for an id.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Id from the accepted request. |

The client binds the pending request's selection, channel and schedule to this id.
No generation or revision field is present.
See [replacement](../interactions/05-replacement.md) for the limits of id reuse.

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
