# SubscriptionAccepted

Server-to-client reliable response accepting the outstanding request for an id.

| Field, in wire order | Encoding | Meaning                                                         |
| -------------------- | -------- | --------------------------------------------------------------- |
| `subscription_id`    | `u32`    | Id from the request.                                            |
| `generation`         | `u32`    | Nonzero acceptance identifier, never reused in this connection. |

The client binds the generation to the pending request's selections, formats, spaces and delivery mode.
These provide the interpretation metadata for [SamplePublication](SamplePublication.md).
See [replacement](../interactions/05-replacement.md) for generation lifetime.

Requirements: [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
