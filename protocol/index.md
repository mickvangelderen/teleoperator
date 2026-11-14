# Tracking protocol specification

Clients discover a device's inputs, poses and skeleton mappings, select the values and representations they need, and subscribe to their publication.
Subscriptions choose reliable or unreliable delivery and periodic or on-change timing.
Sample references associate inputs with edge counters and poses with quality data, while clock exchanges and actual prediction timestamps let clients relate samples to consumption time.

## Status

This is an unpublished version 1 wire specification derived from requirements at commit `067f1ed53383a7c3b7fadc715917b175f114e48b`.
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
8. [Schedule publications and update timing](interactions/08-scheduling.md).

## Reference

| Purpose               | Types                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Negotiation           | [VersionOffer](types/VersionOffer.md), [VersionSelection](types/VersionSelection.md)                                                                                                                                                                  |
| Discovery             | [Capabilities](types/Capabilities.md), [SampleGroup](types/SampleGroup.md), [SampleDescriptor](types/SampleDescriptor.md)                                                                                                                             |
| Skeleton mapping      | [Skeleton](types/Skeleton.md), [Joint](types/Joint.md)                                                                                                                                                                                                |
| Indices               | [SampleGroupIndex](types/SampleGroupIndex.md), [SampleDescriptorIndex](types/SampleDescriptorIndex.md), [JointIndex](types/JointIndex.md), [NonMax](types/NonMax.md)                                                                                  |
| Sample interpretation | [SampleKind](types/SampleKind.md), [SampleFormat](types/SampleFormat.md), [ReferenceSpace](types/ReferenceSpace.md)                                                                                                                                   |
| Subscription          | [Channel](types/Channel.md), [SampleSelection](types/SampleSelection.md), [SampleSelectionEntry](types/SampleSelectionEntry.md), [Subscribe](types/Subscribe.md), [SubscriptionAccepted](types/SubscriptionAccepted.md), [SubscriptionRejected](types/SubscriptionRejected.md) |
| Scheduling | [PublicationSchedule](types/PublicationSchedule.md), [PublicationSchedulePeriodic](types/PublicationSchedulePeriodic.md), [UpdateSchedule](types/UpdateSchedule.md) |
| Time | [Instant](types/Instant.md), [Duration](types/Duration.md) |
| Publication           | [SamplePublication](types/SamplePublication.md)                                                                                                                                                                                                       |
| Unsubscription        | [Unsubscribe](types/Unsubscribe.md), [Unsubscribed](types/Unsubscribed.md)                                                                                                                                                    |
| Clock estimation      | [ClockRequest](types/ClockRequest.md), [ClockResponse](types/ClockResponse.md)                                                                                                                                                                        |

Wire definitions cover [primitives](encoding/primitives.md), [reliable records](encoding/reliable.md), [unreliable messages](encoding/unreliable.md) and [sample publication bodies](encoding/publication.md).
[Worked examples](encoding/examples.md) and [specification vectors](testdata/specification-v1.json) provide exact bytes.
