# SampleDescriptor

One individually selectable source of sample data.

| Field, in wire order | Encoding                                | Meaning                                                 |
| -------------------- | --------------------------------------- | ------------------------------------------------------- |
| `id`                 | `string`                                | Device-stable unique identifier.                        |
| `name`               | `string`                                | Device-provided name.                                   |
| `description`        | `string`                                | Device-provided description.                            |
| `kind`               | [SampleKind](SampleKind.md), `u8`       | Semantic kind.                                          |
| `supported_formats`  | `list<SampleFormat>`                    | Non-empty list of supported [formats](SampleFormat.md). |
| `group`              | [SampleGroupIndex](SampleGroupIndex.md) | Acquisition group.                                      |
| Kind-specific fields | As below                                | Appended in the order shown for the selected kind.      |

For ids corresponding to OpenXR interaction profile components, use the component path.
[SampleDescriptorIndex](SampleDescriptorIndex.md) identifies this descriptor in capabilities.

## pressed

| Field                  | Encoding                        | Meaning                            |
| ---------------------- | ------------------------------- | ---------------------------------- |
| `press_count_sample`   | `Option<SampleDescriptorIndex>` | Associated `press_count` sample.   |
| `release_count_sample` | `Option<SampleDescriptorIndex>` | Associated `release_count` sample. |

## touched

| Field                  | Encoding                        | Meaning                            |
| ---------------------- | ------------------------------- | ---------------------------------- |
| `touch_count_sample`   | `Option<SampleDescriptorIndex>` | Associated `touch_count` sample.   |
| `untouch_count_sample` | `Option<SampleDescriptorIndex>` | Associated `untouch_count` sample. |

## pose

| Field                        | Encoding                        | Meaning                                                  |
| ---------------------------- | ------------------------------- | -------------------------------------------------------- |
| `supported_spaces`           | `list<ReferenceSpace>`          | Non-empty list of supported [spaces](ReferenceSpace.md). |
| `position_valid_sample`      | `Option<SampleDescriptorIndex>` | Applicable `position_valid` sample.                      |
| `orientation_valid_sample`   | `Option<SampleDescriptorIndex>` | Applicable `orientation_valid` sample.                   |
| `position_tracked_sample`    | `Option<SampleDescriptorIndex>` | Applicable `position_tracked` sample.                    |
| `orientation_tracked_sample` | `Option<SampleDescriptorIndex>` | Applicable `orientation_tracked` sample.                 |
| `confidence_sample`          | `Option<SampleDescriptorIndex>` | Applicable `confidence` sample.                          |

## revision

| Field         | Encoding                                | Meaning                              |
| ------------- | --------------------------------------- | ------------------------------------ |
| `revision_of` | [SampleGroupIndex](SampleGroupIndex.md) | Group whose data is being versioned. |

All other kinds have no appended fields.
Optional indices use [NonMax](NonMax.md), with `u32::MAX` denoting absence.
A present sample reference identifies a descriptor of the kind specified by its field.

Requirements: [PRO-0013](../../design/requirements/protocol/PRO-0013.md), [PRO-0020](../../design/requirements/protocol/PRO-0020.md).
