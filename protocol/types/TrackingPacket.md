# TrackingPacket

One server-to-client tracking-channel publication, representing one acquisition of an accepted subscription's group.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `subscription_id` | `u32` | Client-assigned subscription id. |
| `generation` | `u32` | Accepted generation whose request defines the layout. |
| `acquired_at_ns` | `u64` | Group acquisition time in nanoseconds since the server established this connection, using a monotonic clock. |
| `availability` | Packed bitmap | One bit per selected sample in request order. |
| `boolean_values` | Packed bitmap | One bit per available selection using format `bit`, preserving their request order. |
| `numeric_values` | Packed components | Values of available non-`bit` selections in request order and kind-defined component order. |

All values and availability refer to the same group acquisition.
Each distinct acquisition of a group MUST have a strictly increasing timestamp for the connection.
The timestamp is acquisition time, not packet send time or a predicted pose target time.
Subscriptions using the same acquisition share its timestamp.
Neither wall-clock synchronization nor a relationship to the client's clock is implied.
Clients cannot infer absolute one-way latency by subtracting this timestamp from their local clock.

The packet has a fixed 16-byte header followed by the three sections described in [tracking encoding](../encoding/tracking.md).
There is no version, message tag, sample count, schema, or previous-packet dependency in this channel's messages.
The transport supplies the packet boundary.

Sources: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
