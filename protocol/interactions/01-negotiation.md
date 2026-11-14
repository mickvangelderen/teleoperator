# Version negotiation

1. The client sends [VersionOffer](../types/VersionOffer.md) as its first reliable message.
2. The server selects the highest version both peers support and sends [VersionSelection](../types/VersionSelection.md).
3. Selection `0` means no common version; the server ends the connection.
4. A successful selection is followed by [capability advertising](02-capabilities.md).

This draft defines version `1`.
Offer and selection use the fixed [bootstrap encoding](../encoding/reliable.md#bootstrap).
The client rejects a nonzero selection it did not offer.
The selected version applies to both channels for the connection.
No sample publication is sent before negotiation succeeds.

Requirements: [PRO-0004](../../design/requirements/protocol/PRO-0004.md).
