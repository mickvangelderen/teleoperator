# Tracking protocol specification

Clients discover a device's inputs, poses and skeleton mappings, select the values and representations they need, and subscribe to their publication.
Subscriptions choose reliable or unreliable delivery.
Sample references associate inputs with edge counters and poses with quality data, while clock exchanges let clients estimate the age of acquired data.

## Status

This is an unpublished version 1 wire specification derived from requirements at commit `bba9cbea1771a2b3d6ba83e3720da9fbf590a868`.
`MUST`, `MUST NOT` and `SHOULD` express obligations in this specification.
Concrete encoding choices and their requirement basis are recorded in [derivation](derivation.md).

## Reading order

Start with [transport and sessions](overview.md), then follow the interactions:

1. [Negotiate a version](interactions/01-negotiation.md).
2. [Discover capabilities](interactions/02-capabilities.md).
3. [Subscribe](interactions/03-subscription.md).
4. [Receive sample publications](interactions/04-publication.md).
5. [Replace a subscription](interactions/05-replacement.md).
6. [End a subscription](interactions/06-unsubscription.md).
7. [Estimate clock offset and delay](interactions/07-clock-estimation.md).

## Reference

| Purpose               | Types                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Negotiation           | [VersionOffer](types/VersionOffer.md), [VersionSelection](types/VersionSelection.md)                                                                                                                                                                  |
| Discovery             | [Capabilities](types/Capabilities.md), [SampleGroup](types/SampleGroup.md), [SampleDescriptor](types/SampleDescriptor.md)                                                                                                                             |
| Skeleton mapping      | [Skeleton](types/Skeleton.md), [Joint](types/Joint.md)                                                                                                                                                                                                |
| Indices               | [SampleGroupIndex](types/SampleGroupIndex.md), [SampleDescriptorIndex](types/SampleDescriptorIndex.md), [JointIndex](types/JointIndex.md), [NonMax](types/NonMax.md)                                                                                  |
| Sample interpretation | [SampleKind](types/SampleKind.md), [SampleFormat](types/SampleFormat.md), [ReferenceSpace](types/ReferenceSpace.md)                                                                                                                                   |
| Subscription          | [DeliveryMode](types/DeliveryMode.md), [SampleSelection](types/SampleSelection.md), [SubscriptionRequest](types/SubscriptionRequest.md), [SubscriptionAccepted](types/SubscriptionAccepted.md), [SubscriptionRejected](types/SubscriptionRejected.md) |
| Publication           | [SamplePublication](types/SamplePublication.md)                                                                                                                                                                                                       |
| Unsubscription        | [UnsubscribeRequest](types/UnsubscribeRequest.md), [SubscriptionEnded](types/SubscriptionEnded.md)                                                                                                                                                    |
| Clock estimation      | [ClockRequest](types/ClockRequest.md), [ClockResponse](types/ClockResponse.md)                                                                                                                                                                        |

Wire definitions cover [primitives](encoding/primitives.md), [reliable records](encoding/reliable.md), [unreliable messages](encoding/unreliable.md) and [sample publication bodies](encoding/publication.md).
[Worked examples](encoding/examples.md) and [specification vectors](testdata/specification-v1.json) provide exact bytes.
