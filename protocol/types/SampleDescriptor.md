# SampleDescriptor

One individually addressable source of tracking data.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `id` | `string` | Nonempty, device-stable identifier, unique within the advertisement. |
| `name` | `string` | Device-provided human-readable name. |
| `description` | `string` | Device-provided human-readable description. |
| `kind` | [SampleKind](SampleKind.md), `u8` | Semantic meaning and component count. |
| `supported_formats` | `list<SampleFormat>` | Nonempty list of distinct [SampleFormat](SampleFormat.md) values compatible with `kind`. |
| `group` | `u32` | Index into [Capabilities.sample_groups](Capabilities.md). |
| `supported_spaces` | `list<ReferenceSpace>`, only for `kind == pose` | Nonempty list of distinct supported [ReferenceSpace](ReferenceSpace.md) values. |

For all non-pose kinds, the descriptor ends after `group`; there is no kind-specific payload.
Invalid and reserved enum values are forbidden.
Names and descriptions may be empty; identity comes from `id`.

Use an OpenXR interaction profile component path when the source corresponds to such a component.
Other sources, including derived counter values and individually exposed body joints, still need distinct device-stable ids.
A `generic` descriptor denotes one scalar, without protocol-defined units or semantics.

The descriptor's zero-based position in the capabilities list is its compact connection-local selector.
The string id is stable across connections; the list index is not.
See [control encoding](../encoding/control.md) and [primitive encoding](../encoding/primitives.md).

Source: [PRO-0013](../../design/requirements/protocol/PRO-0013.md).
