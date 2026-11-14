# Unreliable message encoding

Each transport message contains one tagged payload:

| Field         | Encoding      | Meaning                                     |
| ------------- | ------------- | ------------------------------------------- |
| `message_tag` | `u8`          | Message type below.                         |
| `payload`     | Type-specific | Fields in the type definition's wire order. |

The payload consumes the rest of the transport message; there is no length prefix.

| Tag    | Type                                               | Direction       | Availability                        |
| ------ | -------------------------------------------------- | --------------- | ----------------------------------- |
| `0x09` | [SamplePublication](../types/SamplePublication.md) | Server → client | Accepted Unreliable subscription.   |
| `0x0A` | [ClockRequest](../types/ClockRequest.md)             | Client → server | After successful version selection. |
| `0x0B` | [ClockResponse](../types/ClockResponse.md)           | Server → client | Response to clock request.          |

Each message, including its tag, must fit the transport's message limit.
Messages are independently decodable and sent without retransmission.
Discard malformed messages, unknown tags and messages received in the wrong direction or before successful negotiation.
Publication validation uses the accepted subscription's [layout](publication.md#validation).

Requirements: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
