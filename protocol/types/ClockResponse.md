# ClockResponse

Server-to-client response to a ClockRequest, sent over the unreliable channel.

| Field, in wire order | Encoding | Meaning                                                                   |
| -------------------- | -------- | ------------------------------------------------------------------------- |
| `request_id`         | `u32`    | Id from the request.                                                      |
| `received_at_ns`     | `u64`    | Server time immediately upon receiving the complete request.              |
| `sent_at_ns`         | `u64`    | Server time immediately before submitting this response for transmission. |

Both timestamps use the same clock and origin as sample acquisition timestamps.
See [clock estimation](../interactions/07-clock-estimation.md).

Requirements: [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
