# Sample publication

A [SamplePublication](../types/SamplePublication.md) is sent on the channel selected by its accepted subscription.
The accepted request and capabilities define the payload layout.

## Receiving a publication

1. Find the accepted subscription matching the subscription id.
2. Discard publications with unknown or retired ids, including unreliable publications for a new id that overtake acceptance.
3. Check that the publication arrived on the selected channel.
4. Decode and validate the complete [publication body](../encoding/publication.md) before exposing its values.

Clients can compare acquisition timestamps to recognize stale arrivals on the unreliable channel.
Id reuse has the [replacement ambiguity](05-replacement.md#unreliable-id-reuse); timestamps do not resolve it.
`predicted_for` reports the actual common prediction time when predicted samples are present.
Publication timing follows the [selected schedule](08-scheduling.md).
Independent decoding does not require receipt of an earlier publication.

## Availability and quality

An unavailable sample has no value payload.
An available zero or false value is distinct from an unavailable sample.
Availability describes the presence of a sample; pose component validity, tracking state and confidence are separate samples referenced by the descriptor.

## Counters

Press, release, touch, untouch and revision counters are maintained independently of subscriptions and wrap at their unsigned width.
Representations of the same counter expose its value modulo their widths.
Device implementations should obtain input transitions from native APIs when available.

For two observations of a `w`-bit edge counter, `(current - previous) mod 2^w` gives the change modulo that width.
A `u8` transition from `254` to `1` represents three increments modulo `256`.
An unavailable counter provides no new observation.
Revision samples identify their target group through `revision_of`.

Requirements: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0008](../../design/requirements/protocol/PRO-0008.md), [PRO-0010](../../design/requirements/protocol/PRO-0010.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md).
