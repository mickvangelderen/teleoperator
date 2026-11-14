# Reliable record encoding

The reliable channel carries a sequence of records:

| Field         | Encoding      | Meaning                                     |
| ------------- | ------------- | ------------------------------------------- |
| `body_length` | `u32`         | Byte length of the tag and payload.         |
| `message_tag` | `u8`          | Message type below.                         |
| `payload`     | Type-specific | Fields in the type definition's wire order. |

The length is at least one and the payload consumes exactly the remaining record bytes.
Writes may split or coalesce records; the receiver parses the ordered byte sequence using the length prefix.

| Tag    | Type                                                     | Direction       | Availability                               |
| ------ | -------------------------------------------------------- | --------------- | ------------------------------------------ |
| `0x01` | [VersionOffer](../types/VersionOffer.md)                 | Client → server | First client message.                      |
| `0x02` | [VersionSelection](../types/VersionSelection.md)         | Server → client | Response to offer.                         |
| `0x03` | [Capabilities](../types/Capabilities.md)                 | Server → client | Initial discovery after version selection. |
| `0x04` | [SubscriptionRequest](../types/SubscriptionRequest.md)   | Client → server | After capabilities.                        |
| `0x05` | [SubscriptionAccepted](../types/SubscriptionAccepted.md) | Server → client | Response to request.                       |
| `0x06` | [SubscriptionRejected](../types/SubscriptionRejected.md) | Server → client | Response to request.                       |
| `0x07` | [UnsubscribeRequest](../types/UnsubscribeRequest.md)     | Client → server | For an accepted generation.                |
| `0x08` | [SubscriptionEnded](../types/SubscriptionEnded.md)       | Server → client | Termination or unsubscription.             |
| `0x09` | [SamplePublication](../types/SamplePublication.md)       | Server → client | Accepted Reliable subscription.            |

Other tags are invalid in version 1.
Control requests are processed in reliable receive order, with responses sent in that order.
The server can interleave publications and subscription-ending notifications between control records.

## Bootstrap

The length prefix, negotiation tags and negotiation payload layouts are fixed before selecting a version.
They use the [primitive encoding](primitives.md).
The selected version then defines the other record types and [unreliable messages](unreliable.md).

Requirements: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0004](../../design/requirements/protocol/PRO-0004.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md).
