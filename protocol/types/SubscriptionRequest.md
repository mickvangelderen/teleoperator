# SubscriptionRequest

Client-to-server control request to create or fully replace a subscription.

| Field, in wire order | Encoding | Meaning |
| --- | --- | --- |
| `subscription_id` | `u32` | Client-assigned id; all `u32` values, including `0`, are usable. |
| `group` | `u32` | Zero-based index into [Capabilities.sample_groups](Capabilities.md). |
| `publication_rate_hz` | `f32` | Finite, positive requested publication rate, no greater than the group's maximum. |
| `samples` | `list<SampleSelection>` | Nonempty ordered list of distinct descriptors and their requested representations. |

See [SampleSelection](SampleSelection.md).
The client controls id allocation; the server controls acceptance.
All selections MUST belong to `group`.
Acceptance preserves their exact order and settings.
A request using an active id replaces the entire subscription only if accepted.

See [subscription behavior](../interactions/03-subscription.md), [replacement](../interactions/05-replacement.md), and [control encoding](../encoding/control.md).

Sources: [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
