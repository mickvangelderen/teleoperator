# ClockRequest

Client-to-server request over the unreliable channel, available after successful version negotiation.

| Field, in wire order | Encoding | Meaning                                            |
| -------------------- | -------- | -------------------------------------------------- |
| `request_id`         | `u32`    | Client-assigned id, not reused in this connection. |

The client captures its send timestamp immediately before submitting this request.
In the disciplined-clock guidance, that capture is the software-clock value `T1`, not the underlying uncorrected monotonic reading.
See [clock estimation](../interactions/07-clock-estimation.md).

Requirements: [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
