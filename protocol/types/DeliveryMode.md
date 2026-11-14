# DeliveryMode

A `u8` selecting the channel for a subscription's publications.

| Mode         | Value  |
| ------------ | ------ |
| invalid      | `0x00` |
| `Unreliable` | `0x01` |
| `Reliable`   | `0x02` |
| reserved     | *      |

See [channel requirements](../overview.md#channels) and [publication framing](../encoding/publication.md).

Requirements: [PRO-0019](../../design/requirements/protocol/PRO-0019.md).
