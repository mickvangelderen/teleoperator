# Version negotiation

1. The client sends a [VersionOffer](../types/VersionOffer.md) as its first control message.
2. The server selects the highest version that both peers support and sends [VersionSelection](../types/VersionSelection.md).
3. If there is no common version, the server sends selection `0` and ends the connection.
4. For a supported selection, the server proceeds to [capability advertising](02-capabilities.md).

This draft defines version `1`.
The offer and selection use the fixed [bootstrap encoding](../encoding/control.md) so they can be decoded before choosing a version.
The client MUST reject a nonzero selection that it did not offer.
No additional negotiation acknowledgement is required: a subscription request follows receipt of the selection and capabilities on ordered control.

The selected version MUST NOT change during the session.
Renegotiation requires a new connection.
No tracking is sent during negotiation, and neither control nor tracking messages carry a recurring version header.

Source: [PRO-0004](../../design/requirements/protocol/PRO-0004.md).
