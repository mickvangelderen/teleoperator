# Clock offset estimation

After version negotiation, the client sends [ClockRequest](../types/ClockRequest.md) and the server returns [ClockResponse](../types/ClockResponse.md), both over the unreliable channel.
Each uses one [tagged transport message](../encoding/unreliable.md).
The client keeps the local send time associated with each outstanding request id.
Ids are not reused within the connection.

| Timestamp | Observation                                                             |
| --------- | ----------------------------------------------------------------------- |
| `t1`      | Client time immediately before submitting the request for transmission. |
| `t2`      | `received_at_ns` in the response.                                       |
| `t3`      | `sent_at_ns` in the response.                                           |
| `t4`      | Client time immediately upon receiving the complete response.           |

Use nanoseconds for all four observations.
The server timestamps use the same clock and origin as sample acquisition times; the client's origin can differ.
Compute signed differences without unsigned wraparound:

```text
server_minus_client = ((t2 - t1) + (t3 - t4)) / 2
round_trip_delay    = (t4 - t1) - (t3 - t2)
client_sample_time  = acquired_at_ns - server_minus_client
```

These are best-effort estimates using the four-timestamp method in [RFC 5905, section 8](https://www.rfc-editor.org/rfc/rfc5905.html#section-8).
Path asymmetry and queuing can affect the estimate.
Responses match outstanding requests by id, regardless of arrival order; responses without an outstanding request are discarded.
Connection loss discards pending observations and the connection's clock estimate.

Requirements: [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
