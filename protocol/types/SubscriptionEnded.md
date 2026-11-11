# SubscriptionEnded

Server-to-client control notification that a subscription generation is no longer active.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `subscription_id` | `u32` | Client-assigned subscription id. |
| `generation` | `u32` | Nonzero generation being ended. |
| `reason` | `string` | Nonempty human-readable explanation. |

The server sends this message after client unsubscription, server termination, or successful replacement of an active generation.
It also responds to unsubscription of an already ended generation with this message.
Reason text is diagnostic; recipients identify the affected state using the id and generation.
An ending notification never rejects a pending replacement or ends a different generation.

See [unsubscription](../interactions/06-unsubscription.md), [replacement](../interactions/05-replacement.md), and [control encoding](../encoding/control.md).

Source: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
