# Tracking protocol specification

This protocol lets a client discover a tracking device's inputs, poses, and body joints, select the data it needs, and receive fresh samples with minimal delay.
Clients choose representations and publication rates to balance precision and bandwidth.
Device-side edge counters preserve observed button and touch transitions even when individual tracking packets are lost.

The server supplies tracking data; the client discovers and subscribes to it.
The same contract supports different tracking devices through advertised sample descriptions and capabilities.

## Status and scope

This is a proposed version 1 specification derived from the hand-written [requirements](../design/requirements/README.md).
It specifies a wire contract; it does not assert compatibility with the existing implementation.
`MUST`, `MUST NOT`, and `SHOULD` express obligations within this draft.
The requirements remain the source of product scope.

The requirements specify behavior and several enumerations but leave concrete framing, field widths, negotiation messages, publication settings, availability encoding, and replacement identification open.
This draft makes those encoding and interaction choices explicit so two implementations can exchange data.
The [derivation record](derivation.md) distinguishes these choices from prescribed requirements and records verification still needed.

## Reading order

Start with [transport and session behavior](overview.md), then follow the interactions:

1. [Negotiate a version](interactions/01-negotiation.md).
2. [Discover capabilities](interactions/02-capabilities.md).
3. [Create a subscription](interactions/03-subscription.md).
4. [Receive tracking data](interactions/04-tracking.md).
5. [Replace a subscription](interactions/05-replacement.md).
6. [End a subscription](interactions/06-unsubscription.md).

## Reference

Each protocol type has its own definition:

| Purpose | Types |
| --- | --- |
| Negotiation | [VersionOffer](types/VersionOffer.md), [VersionSelection](types/VersionSelection.md) |
| Discovery | [Capabilities](types/Capabilities.md), [SampleGroup](types/SampleGroup.md), [SampleDescriptor](types/SampleDescriptor.md) |
| Sample interpretation | [SampleKind](types/SampleKind.md), [SampleFormat](types/SampleFormat.md), [ReferenceSpace](types/ReferenceSpace.md) |
| Subscription | [SampleSelection](types/SampleSelection.md), [SubscriptionRequest](types/SubscriptionRequest.md), [SubscriptionAccepted](types/SubscriptionAccepted.md), [SubscriptionRejected](types/SubscriptionRejected.md) |
| Tracking | [TrackingPacket](types/TrackingPacket.md) |
| Unsubscription | [UnsubscribeRequest](types/UnsubscribeRequest.md), [SubscriptionEnded](types/SubscriptionEnded.md) |

Wire definitions cover [primitives](encoding/primitives.md), [control messages](encoding/control.md), and [tracking packets](encoding/tracking.md).
[Worked examples](encoding/examples.md) give exact bytes and payload sizes.
