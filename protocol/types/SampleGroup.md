# SampleGroup

Samples acquired together by the tracking device.

| Field, in wire order | Encoding | Meaning                                                  |
| -------------------- | -------- | -------------------------------------------------------- |
| `max_sample_rate_hz` | `f32`    | Finite, positive maximum acquisition frequency in hertz. |

Membership is given by `SampleDescriptor.group`.
[SampleGroupIndex](SampleGroupIndex.md) identifies the group in capabilities.

Requirements: [PRO-0012](../../design/requirements/protocol/PRO-0012.md).
