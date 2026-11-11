# SubscriptionRejected

Server-to-client control response rejecting the outstanding request for an id.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `subscription_id` | `u32` | Id from the rejected request. |
| `reason` | `string` | Nonempty human-readable explanation. |

There MUST be a corresponding outstanding request.
The response does not create or modify a subscription.
An existing generation remains active unless separately ended.
Reason text is diagnostic, not a machine-readable error code or a trigger for automatic retry.

See [subscription validation](../interactions/03-subscription.md) and [control encoding](../encoding/control.md).

Source: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
