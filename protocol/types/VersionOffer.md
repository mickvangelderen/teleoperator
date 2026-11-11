# VersionOffer

Client-to-server control message that begins a new session.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `supported_versions` | `list<u16>` | Nonempty list of distinct supported protocol versions; `0` is forbidden. |

This draft's version is `1`.
The list need not be sorted; the server selects the highest common version.
See [negotiation](../interactions/01-negotiation.md) and [bootstrap framing](../encoding/control.md).

Source: [PRO-0004](../../design/requirements/protocol/PRO-0004.md).
