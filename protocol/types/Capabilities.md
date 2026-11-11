# Capabilities

Server-to-client control advertisement of all selectable tracking sources for this connection.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `sample_groups` | `list<SampleGroup>` | Ordered acquisition groups. |
| `sample_descriptors` | `list<SampleDescriptor>` | Ordered descriptions of individually selectable samples. |

See [SampleGroup](SampleGroup.md) and [SampleDescriptor](SampleDescriptor.md).
List positions are zero-based indices used in descriptors and subscription requests.
The order and contents MUST remain unchanged for the connection.
An empty device advertisement is valid; every advertised descriptor must still reference an existing group.

See [capability advertising](../interactions/02-capabilities.md), [control encoding](../encoding/control.md), and [list encoding](../encoding/primitives.md).

Source: [PRO-0016](../../design/requirements/protocol/PRO-0016.md).
