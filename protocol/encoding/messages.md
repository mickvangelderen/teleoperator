# Message encoding

Each binary transport message contains exactly one protocol message, on either channel:

| Field | Encoding | Meaning |
| ----- | -------- | ------- |
| `message_tag` | `u8` | Message type below. |
| `payload` | Type-specific | Fields in the type definition's wire order. |

The payload consumes the rest of the transport message.
There is no application length prefix, splitting or coalescing of protocol messages.
The complete message, including its tag, must fit the transport binding's message limit and any smaller negotiated peer limit.
The same tag and payload bytes encode a publication on either channel; the accepted subscription determines its channel.

| Tag | Type | Direction | Channel and availability |
| --- | ---- | --------- | ------------------------ |
| `0x01` | [VersionOffer](../types/VersionOffer.md) | Client → server | Reliable; first client message. |
| `0x02` | [VersionSelection](../types/VersionSelection.md) | Server → client | Reliable; response to offer. |
| `0x03` | [Capabilities](../types/Capabilities.md) | Server → client | Reliable; initial discovery after selection. |
| `0x04` | [Subscribe](../types/Subscribe.md) | Client → server | Reliable; after capabilities. |
| `0x05` | [SubscriptionAccepted](../types/SubscriptionAccepted.md) | Server → client | Reliable; response to request. |
| `0x06` | [SubscriptionRejected](../types/SubscriptionRejected.md) | Server → client | Reliable; response to request. |
| `0x07` | [Unsubscribe](../types/Unsubscribe.md) | Client → server | Reliable; for a subscription id. |
| `0x08` | [Unsubscribed](../types/Unsubscribed.md) | Server → client | Reliable; termination or unsubscription. |
| `0x09` | [Publication](../types/Publication.md) | Server → client | Accepted subscription's channel. |
| `0x0A` | [ClockRequest](../types/ClockRequest.md) | Client → server | Unreliable; after successful version selection. |
| `0x0B` | [ClockResponse](../types/ClockResponse.md) | Server → client | Unreliable; response to clock request. |
| `0x0C` | [UpdateSchedule](../types/UpdateSchedule.md) | Client → server | Reliable; update interval, phase and prediction offset. |
| `0x0D` | [PublicationAcknowledged](../types/PublicationAcknowledged.md) | Client → server | Unreliable; exact acknowledgment using the subscription's sequence format. |

Other tags are invalid in version 1.
Control requests are processed in reliable receive order, with responses sent in that order.
The server can interleave publications and subscription-ending notifications between control messages.
Unreliable messages are sent without retransmission.
Discard malformed unreliable messages, unknown tags and messages received in the wrong direction or before successful negotiation.
Reliable control errors follow the [session rules](../overview.md#invalid-messages); publication validation uses the accepted subscription's [layout](publication.md#validation).

## Bootstrap

The one-byte negotiation tags and negotiation payload layouts are fixed before selecting a version.
They use the [primitive encoding](primitives.md).
The selected version then defines the other message types on both channels.

Requirements: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0004](../../design/requirements/protocol/PRO-0004.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md), [PRO-0021](../../design/requirements/protocol/PRO-0021.md), [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
