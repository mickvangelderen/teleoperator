# VersionSelection

Server-to-client reliable response to [VersionOffer](VersionOffer.md).

| Field, in wire order | Encoding | Meaning                                                                |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| `selected_version`   | `u16`    | Selected offered version, or `0` when no offered version is supported. |

A nonzero selection fixes the version for both channels for the entire connection.
Selection `0` is a negotiation failure, not a protocol version; the server sends it and ends the connection.
See [negotiation](../interactions/01-negotiation.md) and [bootstrap framing](../encoding/reliable.md).

Source: [PRO-0004](../../design/requirements/protocol/PRO-0004.md).
