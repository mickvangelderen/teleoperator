# SampleSelection

An ordered selection of samples and their representations from one acquisition group.

| Field, in wire order | Encoding | Meaning |
| -------------------- | -------- | ------- |
| `group` | [SampleGroupIndex](SampleGroupIndex.md) | Group containing every selected sample. |
| `samples` | `list<SampleSelectionEntry>` | Non-empty list of [entries](SampleSelectionEntry.md), in publication order. |

Requirements: [PRO-0025](../../design/requirements/protocol/PRO-0025.md).
