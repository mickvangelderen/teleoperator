# PublicationAcknowledged

Client-to-server acknowledgment over the unreliable channel for a subscription with a configured sequence format.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `subscription_id` | `u32` | Accepted subscription whose publication was received. |
| `sequence_number` | Selected [sequence representation](SequenceNumberFormat.md) | Exact publication received. |

The payload occupies 6, 8 or 12 bytes for u16, u32 or u64 sequences.
The acknowledgment carries neither a format tag nor a bundle bitmap: the subscription supplies the width and the server associates the sequence with the bundle states sent in that publication.
It does not acknowledge earlier publications or bundles omitted from that publication.
An unknown or ended subscription, an absent sequence format, a malformed payload, or an unrecognized sequence is ignored.
See [acknowledgment processing](../interactions/04-publication.md#acknowledgments).

Requirements: [PRO-0028](../../design/requirements/protocol/PRO-0028.md).
