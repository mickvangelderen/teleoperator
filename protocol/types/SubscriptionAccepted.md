# SubscriptionAccepted

Server-to-client control response accepting the outstanding request for an id exactly as requested.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `subscription_id` | `u32` | Id from the accepted request. |
| `generation` | `u32` | Nonzero server-assigned identifier, never reused in this connection. |

The client associates this generation with the outstanding [SubscriptionRequest](SubscriptionRequest.md), including its ordered selections, formats, reference spaces, and rate.
Together, these supply the interpretation metadata for [TrackingPacket](TrackingPacket.md).
No echoed schema is required because acceptance never changes the request.
There MUST be a corresponding outstanding request.

See [replacement](../interactions/05-replacement.md) for generation lifetime and [control encoding](../encoding/control.md) for framing.

Source: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
