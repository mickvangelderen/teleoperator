# Control wire format

Every control message is one record:

| Field | Encoding | Meaning |
| --- | --- | --- |
| `body_length` | `u32` | Bytes following this field, including the one-byte message tag. |
| `message_tag` | `u8` | Message type from the table below. |
| `payload` | Type-specific fields | Fields from the linked type definition, in its listed wire order. |

`body_length` MUST be at least `1`.
The payload MUST consume exactly the remaining record bytes; trailing bytes are invalid.
On a stream, read the four-byte length and then that many body bytes before processing the message.
On a message transport, the same framing is retained; stream segmentation or transport message boundaries do not change the encoded record.
Transport writes can split or coalesce control records, so receivers process the ordered byte sequence using the length prefix.

| Tag | Message type | Direction | Session phase |
| --- | --- | --- | --- |
| `0x01` | [VersionOffer](../types/VersionOffer.md) | Client → server | First client message only. |
| `0x02` | [VersionSelection](../types/VersionSelection.md) | Server → client | Response to the offer only. |
| `0x03` | [Capabilities](../types/Capabilities.md) | Server → client | Once, immediately after successful selection. |
| `0x04` | [SubscriptionRequest](../types/SubscriptionRequest.md) | Client → server | After capabilities. |
| `0x05` | [SubscriptionAccepted](../types/SubscriptionAccepted.md) | Server → client | Response to an outstanding request. |
| `0x06` | [SubscriptionRejected](../types/SubscriptionRejected.md) | Server → client | Response to an outstanding request. |
| `0x07` | [UnsubscribeRequest](../types/UnsubscribeRequest.md) | Client → server | After capabilities, for a previously accepted generation. |
| `0x08` | [SubscriptionEnded](../types/SubscriptionEnded.md) | Server → client | Termination or response to unsubscription. |

Tags `0x00` and `0x09`–`0xFF` are invalid in this version.
Messages sent in the wrong direction or phase end the connection.
After capabilities, the server processes client requests in control receive order and enqueues their responses in that order.
Spontaneous subscription termination notifications can appear between responses.

## Bootstrap

The length prefix, tags `0x01` and `0x02`, and the two negotiation payload layouts are the bootstrap contract, independent of the eventual selected version.
They use the [primitive encoding](primitives.md) defined here.
This lets peers with different supported versions exchange an offer and selection without first decoding version-specific messages.
Version-specific control begins with capabilities after a nonzero selection.

There is no common per-message version field.
After negotiation, the selected version determines the interpretation of both channels for the connection.

## Type layout

Every [type definition](../index.md#reference) lists fields in wire order.
Nested lists and structs follow [primitive encoding](primitives.md).
The only conditional descriptor field in version 1 is `SampleDescriptor.supported_spaces`, present exactly when `kind == pose`.
Every `SampleSelection` is six bytes, including the absent-space marker for non-pose kinds.

The server rejects a structurally readable subscription with unsupported values by sending `SubscriptionRejected` with a reason.
An unreadable record, an invalid advertisement, or an unrecognized tag ends the connection instead of guessing a layout.

Sources: [PRO-0001](../../design/requirements/protocol/PRO-0001.md), [PRO-0004](../../design/requirements/protocol/PRO-0004.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
