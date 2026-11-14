# ClockRequest

Client-to-server request over the unreliable channel, available after successful version negotiation.

| Field, in wire order | Encoding | Meaning                                            |
| -------------------- | -------- | -------------------------------------------------- |
| `request_id`         | `u32`    | Client-assigned id, not reused in this connection. |

The client records its local send timestamp when submitting this request.
See [clock estimation](../interactions/07-clock-estimation.md).

Requirements: [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
