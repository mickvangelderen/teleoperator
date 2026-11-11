# SampleGroup

A collection of samples acquired together by the tracking device.
Membership is given by the `group` field of each [SampleDescriptor](SampleDescriptor.md).

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `max_sample_rate_hz` | `f32` | Finite, positive maximum acquisition frequency in hertz. |

The group is identified by its zero-based position in [Capabilities.sample_groups](Capabilities.md).
One subscription selects from one group, allowing its values to share an acquisition timestamp.
A group's maximum rate is a capability, not a promise that every requested combination of subscriptions can be serviced at that rate.

See [primitive encoding](../encoding/primitives.md).

Source: [PRO-0012](../../design/requirements/protocol/PRO-0012.md), which supersedes [PRO-0009](../../design/requirements/protocol/PRO-0009.md).
