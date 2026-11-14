# Derivation and verification

## Requirement baseline

This revision derives only from committed requirements at `bba9cbea1771a2b3d6ba83e3720da9fbf590a868`.
Uncommitted requirement edits and `cap_change.md` are outside this revision.
The protocol remains unpublished version 1; compatibility with earlier draft bytes is not a constraint.

## Wire choices

The requirements prescribe the data and interactions.
The following choices make their wire representation concrete:

| Choice                                                                               | Purpose                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Fixed bootstrap, version 1, highest common offered version                           | Negotiate before decoding version-specific messages.                                        |
| Little-endian fixed-width integers, UTF-8 strings and one-byte tags                  | Provide compact, directly parseable records.                                                |
| Length-prefixed reliable records; one tag and payload per unreliable message         | Distinguish publications and clock messages while preserving independent decoding.           |
| A requested publication frequency encoded as f32                                     | Give the subscription's publication settings a concrete representation.                     |
| Connection-wide nonzero acceptance generations                                       | Distinguish delayed publications and termination requests after subscription-id reuse.      |
| One pending operation per subscription id                                            | Correlate responses without an extra request identifier.                                    |
| One monotonic acquisition timestamp per publication, using the server's clock origin | Share acquisition time within a group and support the required clock-offset calculation.    |
| Complete availability bitmap, filtered boolean bitmap and packed numeric components  | Encode absence independently of zero and retain independent publication decoding.           |
| Kind-specific descriptor tails and NonMax optional indices                           | Encode the required input, quality and revision references without per-field presence tags. |
| Binary64 quaternion normalization and existing f32/f64 norm-squared tolerances       | Make the required unit-quaternion representation interoperable.                             |
| Clock tags `0x0A` and `0x0B` on the unreliable channel                                | Carry the required clock exchange without retransmission or ordered delivery.               |

These are wire-format choices, not additional product requirements.
The requested rate is recorded as a request setting; the old scheduler cadence and maximum-publication-frequency rules have been removed.
The server clock origin replaces the earlier connection-start origin, so an initial current-state publication can identify an acquisition that predates subscription or connection establishment.

## Changes from the earlier draft

- Both delivery modes use SamplePublication; reliable records now carry publications as well as control messages.
- Capabilities include skeleton mappings, descriptors include their required typed associations, and semantic kinds include revisions and quality.
- Input references replace reliance on derived-id suffixes for association.
- The all-or-nothing partial-pose rule, strict timestamp-increase rule, counter-reset termination rule and reconnect-on-contract-change prescription are removed.
- Clock estimation uses the required four timestamps over the unreliable channel; no clock history, clock synchronization service or prediction policy is added.

The requirement source does not include a capability replacement interaction in this revision.
The discovery flow remains the initial advertisement following negotiation.

## Requirement coverage

| Requirement                                             | Concern                       | Specification                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PRO-0001](../design/requirements/protocol/PRO-0001.md) | Efficient encoding            | [Primitives](encoding/primitives.md), [publication body](encoding/publication.md), [examples](encoding/examples.md).                                 |
| [PRO-0002](../design/requirements/protocol/PRO-0002.md) | Channel delivery              | [Transport](overview.md#channels), [reliable records](encoding/reliable.md), [publication framing](encoding/publication.md).                         |
| [PRO-0003](../design/requirements/protocol/PRO-0003.md) | Device independence           | [Capabilities](types/Capabilities.md), [SampleDescriptor](types/SampleDescriptor.md).                                                                |
| [PRO-0004](../design/requirements/protocol/PRO-0004.md) | Version negotiation           | [Negotiation](interactions/01-negotiation.md), [bootstrap](encoding/reliable.md#bootstrap).                                                          |
| [PRO-0005](../design/requirements/protocol/PRO-0005.md) | Connection state              | [Lifecycle](overview.md#session-lifecycle), [termination](interactions/06-unsubscription.md).                                                        |
| [PRO-0006](../design/requirements/protocol/PRO-0006.md) | Availability                  | [Publication values](interactions/04-publication.md#availability-and-quality), [availability encoding](encoding/publication.md#availability).        |
| [PRO-0007](../design/requirements/protocol/PRO-0007.md) | Selection                     | [SampleSelection](types/SampleSelection.md), [SubscriptionRequest](types/SubscriptionRequest.md).                                                    |
| [PRO-0008](../design/requirements/protocol/PRO-0008.md) | Input edges                   | [Descriptor references](types/SampleDescriptor.md), [counters](interactions/04-publication.md#counters).                                             |
| [PRO-0010](../design/requirements/protocol/PRO-0010.md) | Formats and wrapping counters | [SampleFormat](types/SampleFormat.md), [counter behavior](interactions/04-publication.md#counters).                                                  |
| [PRO-0011](../design/requirements/protocol/PRO-0011.md) | Semantic kinds                | [SampleKind](types/SampleKind.md).                                                                                                                   |
| [PRO-0012](../design/requirements/protocol/PRO-0012.md) | Acquisition groups            | [SampleGroup](types/SampleGroup.md), [SampleGroupIndex](types/SampleGroupIndex.md).                                                                  |
| [PRO-0013](../design/requirements/protocol/PRO-0013.md) | Descriptor references         | [SampleDescriptor](types/SampleDescriptor.md), [SampleDescriptorIndex](types/SampleDescriptorIndex.md).                                              |
| [PRO-0014](../design/requirements/protocol/PRO-0014.md) | Subscriptions                 | [Subscription](interactions/03-subscription.md), [replacement](interactions/05-replacement.md), [unsubscription](interactions/06-unsubscription.md). |
| [PRO-0015](../design/requirements/protocol/PRO-0015.md) | Reference spaces              | [ReferenceSpace](types/ReferenceSpace.md).                                                                                                           |
| [PRO-0016](../design/requirements/protocol/PRO-0016.md) | Capability discovery          | [Capabilities](types/Capabilities.md), [discovery](interactions/02-capabilities.md).                                                                 |
| [PRO-0017](../design/requirements/protocol/PRO-0017.md) | Skeletons                     | [Skeleton](types/Skeleton.md).                                                                                                                       |
| [PRO-0018](../design/requirements/protocol/PRO-0018.md) | Joints                        | [Joint](types/Joint.md), [JointIndex](types/JointIndex.md).                                                                                          |
| [PRO-0019](../design/requirements/protocol/PRO-0019.md) | Delivery choice               | [DeliveryMode](types/DeliveryMode.md), [request](types/SubscriptionRequest.md).                                                                      |
| [PRO-0020](../design/requirements/protocol/PRO-0020.md) | NonMax                        | [NonMax](types/NonMax.md).                                                                                                                           |
| [PRO-0021](../design/requirements/protocol/PRO-0021.md) | Clock estimation              | [ClockRequest](types/ClockRequest.md), [ClockResponse](types/ClockResponse.md), [four-timestamp exchange](interactions/07-clock-estimation.md).      |

The operator requirements OP-0001 through OP-0003 concern the same packing, fresh-data delivery and device-independence goals.
The current protocol requirements define the two selectable delivery modes.

## Verification

[Specification vectors](testdata/specification-v1.json) and [worked examples](encoding/examples.md) cover this revision's wire format.
Run `python3 protocol/tools/verify-specification.py` to check the vectors, numeric examples and documentation links against the committed requirement baseline.

The existing [application fixture](testdata/protocol-v1.json) exercises the applications' earlier wire implementation.
It is preserved as an implementation snapshot and does not establish conformance to this revised specification.
The operator and viewer need a separate implementation update.

The static examples do not establish packing efficiency on realistic recordings.
PRO-0001 requires measurements using representative source data; protocol changes alone do not supply that evidence.
