# SubscriptionRejected

Server-to-client reliable response rejecting the outstanding Subscribe request for an id.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Id from the rejected request. |
| `reason` | `Option<string>` | Optional explanation. |

The optional reason uses a `u8` presence tag: `0` means absent; `1` is followed by a [string](../encoding/primitives.md).
Other presence tags are invalid.
An empty present string and an absent reason are distinct encodings.
Servers SHOULD explain a rejection.
Rejection leaves any existing subscription unchanged.

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
