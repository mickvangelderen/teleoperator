# Derivation and verification

The hand-written requirements prescribe functionality; this draft supplies a concrete representation of that functionality.
This record makes design choices visible without treating them as newly approved requirements.

## Choices made to define the wire contract

| Choice | Purpose and requirement basis |
| --- | --- |
| Proposed version `1`; fixed bootstrap offer and selection; highest common version | Makes the version negotiation required by PRO-0004 executable before version-specific decoding. |
| Little-endian binary fields; fixed-width counts and ids; UTF-8 strings; one-byte tags | Defines unambiguous encoding with straightforward fixed-width parsing, following PRO-0001. |
| Zero-based descriptor and group indices within a fixed connection advertisement | Makes the selections in PRO-0007, PRO-0013, and PRO-0016 compact while retaining device-stable string identity. |
| One requested publication rate per subscription, accepted exactly or rejected | Gives concrete form to the publication settings and group rate limit in PRO-0012 and PRO-0014. |
| One nonzero server-assigned generation per acceptance; generation present in tracking and termination | Supplies the interpretation metadata needed to distinguish delayed packets during full replacement under PRO-0002 and PRO-0014. |
| At most one outstanding subscription request per id | Correlates accept/reject responses without adding a separate request id. |
| One monotonic nanosecond acquisition timestamp per packet | Represents the shared acquisition time in PRO-0012 and permits rejecting reordered older tracking under PRO-0002 without an additional sequence number. |
| Complete availability bitmap; omit unavailable values; pack booleans separately | Distinguishes absent values from valid zero under PRO-0006 while keeping high-volume tracking compact under PRO-0001. |
| Exact normalized-integer mappings and rounding | Makes the normalized formats specified in PRO-0010 interoperable. |
| Right-handed pose coordinates following the named OpenXR spaces | Makes the pose and reference-space semantics in PRO-0011 and PRO-0015 concrete. |

Concrete transport selection, connectivity setup, and platform integration remain binding-specific because the requirements specify channel behavior rather than a transport implementation.
The transport binding must still satisfy every obligation in the [overview](overview.md).

## Requirement coverage

| Requirement | Specification location |
| --- | --- |
| [PRO-0001: Efficient packing](../design/requirements/protocol/PRO-0001.md) | [Primitives](encoding/primitives.md), [tracking encoding](encoding/tracking.md), [size example](encoding/examples.md#payload-size-calculation). |
| [PRO-0002: Fresh tracking](../design/requirements/protocol/PRO-0002.md) | [Transport classification](overview.md#required-transport-behavior), [independent publication and freshness](interactions/04-tracking.md). |
| [PRO-0003: Device independence](../design/requirements/protocol/PRO-0003.md) | [Capabilities](types/Capabilities.md), [descriptors](types/SampleDescriptor.md), [semantic kinds](types/SampleKind.md). |
| [PRO-0004: Evolution](../design/requirements/protocol/PRO-0004.md) | [Negotiation](interactions/01-negotiation.md), [bootstrap wire format](encoding/control.md#bootstrap). |
| [PRO-0005: Connection-local state](../design/requirements/protocol/PRO-0005.md) | [Session lifecycle](overview.md#session-lifecycle), [unsubscription and termination](interactions/06-unsubscription.md). |
| [PRO-0006: Missing versus zero](../design/requirements/protocol/PRO-0006.md) | [Availability semantics](interactions/04-tracking.md#availability), [availability encoding](encoding/tracking.md#availability-section). |
| [PRO-0007: Data selection](../design/requirements/protocol/PRO-0007.md) | [SampleSelection](types/SampleSelection.md), [SubscriptionRequest](types/SubscriptionRequest.md), individually selectable joints in the [overview](overview.md#interpreting-samples). |
| [PRO-0008: Edge changes](../design/requirements/protocol/PRO-0008.md) | [Counter advertising](interactions/02-capabilities.md), [edge counter behavior](interactions/04-tracking.md#edge-counters). |
| [PRO-0009: Superseded acquisition groups](../design/requirements/protocol/PRO-0009.md) | Implemented through PRO-0012; no separate group model. |
| [PRO-0010: Sample formats](../design/requirements/protocol/PRO-0010.md) | [SampleFormat](types/SampleFormat.md), [counter lifetime and wrapping](interactions/04-tracking.md#edge-counters). |
| [PRO-0011: Sample kinds](../design/requirements/protocol/PRO-0011.md) | [SampleKind](types/SampleKind.md). |
| [PRO-0012: Sample groups](../design/requirements/protocol/PRO-0012.md) | [SampleGroup](types/SampleGroup.md), [subscription rate](interactions/03-subscription.md#publication-rate), [acquisition timestamp](types/TrackingPacket.md). |
| [PRO-0013: Sample descriptors](../design/requirements/protocol/PRO-0013.md) | [SampleDescriptor](types/SampleDescriptor.md). |
| [PRO-0014: Message flow](../design/requirements/protocol/PRO-0014.md) | [Session sequence](overview.md#session-lifecycle), [subscription](interactions/03-subscription.md), [replacement](interactions/05-replacement.md), [termination](interactions/06-unsubscription.md). |
| [PRO-0015: Reference spaces](../design/requirements/protocol/PRO-0015.md) | [ReferenceSpace](types/ReferenceSpace.md), [pose space selection](types/SampleSelection.md). |
| [PRO-0016: Capabilities](../design/requirements/protocol/PRO-0016.md) | [Capabilities](types/Capabilities.md), [advertisement interaction](interactions/02-capabilities.md). |
| [OP-0001](../design/requirements/operator/OP-0001.md), [OP-0002](../design/requirements/operator/OP-0002.md), [OP-0003](../design/requirements/operator/OP-0003.md) | Same packing, freshness, and device-independence contract as PRO-0001 through PRO-0003. |

## Verification still required

The specification and worked bytes do not establish implementation conformance or measured packing efficiency.
PRO-0001 and OP-0001 require realistic recordings to evaluate serialized entropy and bandwidth.
An implementation should measure representative input, pose, and joint recordings with selected formats, counter widths, availability changes, and subscription rates.
Report the recording distribution, encoded bytes per sample and second, and entropy method; a static size example alone cannot establish the required result.

Implementation conformance also needs exercised cases for loss and reordering, tracking overtaking acceptance, accepted and rejected replacement, late packets after unsubscription, valid zero versus unavailable, counter wrap, and reconnecting after server restart.
These cases follow directly from the required lifecycle and delivery semantics.
