# Publication and acknowledgment

A [Publication](../types/Publication.md) uses the accepted subscription's channel and layout.
Bundle 0 is always included; bundles 1 onward are included while their latest state is pending acknowledgment.
New acquisitions never wait for an acknowledgment of an earlier state.

## Bundle state

Initialize every bundle after bundle 0 as pending when the subscription is accepted.
On each acquisition, compare each such bundle's selected encoded values with its previous state.
A change makes that bundle pending, superseding its older state.
Compare meaningful value bits and numeric bytes, ignoring unused bitmap bits.
Changes to timestamps or unselected samples alone do not make a bundle pending.

At a publication opportunity, include bundle 0 and every pending bundle, using the latest available acquisition for all included values.
If bundle 0 is empty and no other bundle is pending, send nothing.
Repeat pending bundles at scheduled slots until acknowledged, including when the acquisition has not changed.
Each repeat is a new publication with its own sequence number; no earlier publication is needed to decode it.
These rules apply on both publication channels.

An acknowledgment can confirm only the state included in that exact publication.
An intervening observed change supersedes that state, including a change away and back to the same encoded bytes.
Acknowledgment processing must account for all already observed acquisitions, so it cannot clear a newly observed change.

## Receiving a publication

The [pending replacement rules](05-replacement.md#while-replacement-is-pending) take precedence while a same-id replacement is outstanding.
Otherwise:

1. Resolve an accepted subscription by id and check the selected channel.
2. Discard unknown or retired ids, including unreliable publications that overtake acceptance.
3. Decode and validate the complete [publication body](../encoding/publication.md).
4. Apply included bundles that are newer than their last applied publication, tracking order per bundle.
5. If an on-change bundle is included, send [PublicationAcknowledged](../types/PublicationAcknowledged.md) for this exact publication, including valid duplicates and older arrivals within the sequence window.

A sequenced publication containing only bundle 0 requires no acknowledgment.
A client may acknowledge it, but that acknowledgment has no effect on pending bundles.

When sequenced, track the newest sequence across the whole subscription using [wrapping comparison](../types/SequenceNumberFormat.md).
Unwrap each received sequence to a local integer position relative to that newest publication: add the forward difference when it is less than half the range, or subtract the backward distance for an older arrival.
Compare these positions per bundle, so a bundle omitted for many publications can still advance when next included.
The first valid publication establishes the initial position.
Discard an exactly half-range ambiguous publication without applying or acknowledging it.
Without sequences, use acquisition time to avoid replacing a newer acquisition with an older arrival on the unreliable channel.
Equal acquisition times may repeat a cached snapshot.
Omitted bundles retain their previously received values and acquisition metadata; they do not acquire the new publication's timestamp.
Retained bundles do not form a new common acquisition merely because a later publication arrived.

## Acknowledgments

Acknowledgments always use the unreliable channel, including for reliable publications.
For a recognized sequence in sent history, clear pending state only for bundles that publication contained and whose current state still matches the recorded state.
An acknowledgment of one publication never implies receipt of earlier publications.
A duplicate, unknown or expired acknowledgment has no additional effect.
A delayed acknowledgment for a superseded state cannot clear the newer state.

For example, sequence 4 contains states A1 and B1; sequence 5 contains A2 and B1.
Acknowledging 4 clears B1 but leaves A2 pending.
Acknowledging 5 then clears A2 if it has not changed again.
Lost acknowledgments cause new publications of the pending latest state, which the client acknowledges again.
Neither side retransmits an old protocol message on the unreliable channel.
Eventual receipt requires continued publication opportunities and eventual successful delivery in both directions; delivery is not guaranteed under permanent loss.

## Server bookkeeping guidance

One implementation assigns an internal revision to each bundle on every observed value change and records included revisions by sent publication sequence.
Match those recorded revisions against current revisions when processing an acknowledgment.
Bound this history and retire records outside the [sequence window](../types/SequenceNumberFormat.md).
An unrecognized acknowledgment cannot clear pending state; a later publication can confirm it.
These data structures are local choices, not wire fields or a required storage algorithm.

## Values and quality

Every binding in an included bundle has a complete value representation.
Pose validity, tracking state and confidence are separate samples referenced by descriptors.
Servers can define ordinary status samples and qualified placeholders for inactive sources; their descriptions and policy must distinguish placeholders from measured zero or false.
Clients select the status samples they need; selection never adds them implicitly.
Selecting a value and its status in the same bundle keeps their received acquisition metadata together.
The [operator policy](../bindings/operator.md#source-quality) defines one mapping without extending the descriptor schema.

An unrepresentable selected source or encoding failure rejects a known-unfulfillable request or ends the affected subscription through [Unsubscribed](../types/Unsubscribed.md).
It cannot be hidden by clearing a bundle's presence bit.
Ordinary inactive states with defined complete representations do not require termination.

## Counters

Press, release, touch, untouch and revision counters are maintained independently of subscriptions and wrap at their unsigned width.
Representations of the same counter expose its value modulo their widths.
Device implementations should obtain input transitions from native APIs when available.
For a `w`-bit edge counter, `(current - previous) mod 2^w` gives the change modulo that width: `254` to `1` at u8 represents three increments modulo 256.
Revision samples identify their target group through `revision_of`.

Requirements: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0006](../../design/requirements/protocol/PRO-0006.md), [PRO-0008](../../design/requirements/protocol/PRO-0008.md), [PRO-0010](../../design/requirements/protocol/PRO-0010.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md).
