# SamplePublication

One server-to-client publication of an accepted subscription's selected samples.

| Field, in wire order | Encoding          | Meaning                                                            |
| -------------------- | ----------------- | ------------------------------------------------------------------ |
| `subscription_id`    | `u32`             | Client-assigned id.                                                |
| `generation`         | `u32`             | Accepted generation defining the payload layout.                   |
| `acquired_at_ns`     | `u64`             | Group acquisition time on the server's monotonic nanosecond clock. |
| `availability`       | Packed bitmap     | One bit per selected sample in request order.                      |
| `boolean_values`     | Packed bitmap     | Available `bit` values, in request order.                          |
| `numeric_values`     | Packed components | Available non-`bit` values, in request and component order.        |

The timestamp uses the same clock and origin as [ClockResponse](ClockResponse.md).
The server defines the clock's origin.
[Clock estimation](../interactions/07-clock-estimation.md) relates it to the client's clock.

The body has a 16-byte header followed by the value sections in [publication encoding](../encoding/publication.md).
Delivery uses the accepted subscription's channel.

Requirements: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md), [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
