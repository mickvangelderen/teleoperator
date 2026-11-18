# Tracking protocol specification

Clients discover a device's inputs, poses and skeleton mappings, select the values and representations they need, and subscribe to their publication.
Subscriptions choose reliable or unreliable delivery, control publication timing, and group values into continuously published or acknowledged on-change bundles.
Sample references associate inputs with edge counters and poses with quality data, while clock exchanges and actual prediction timestamps let clients relate samples to consumption time.

## Status

This is an unpublished version 1 wire specification derived from requirements at commit `da17cd684a906ca77ab66aa90912ccdb8ea0d017`, with the explicit [feedback overrides](derivation.md#feedback-overrides).
The transport, interaction, type and encoding definitions are normative, including declarative constraints and imperative rules without capitalized keywords.
`MUST` and `MUST NOT` emphasize requirements; `SHOULD` identifies a recommendation that permits a justified exception.
Sections explicitly labeled guidance, examples, derivation and cited design considerations are informative.
The operator binding defines additional policies for that binding only.
Observable delivery, ordering and acknowledgment rules are required; suggested local data structures are implementation guidance.
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
| Subscription          | [Channel](types/Channel.md), [SampleBinding](types/SampleBinding.md), [SequenceNumberFormat](types/SequenceNumberFormat.md), [Subscribe](types/Subscribe.md), [SubscriptionAccepted](types/SubscriptionAccepted.md), [SubscriptionRejected](types/SubscriptionRejected.md) |
| Scheduling | [UpdateSchedule](types/UpdateSchedule.md) |
| Time | [Instant](types/Instant.md), [Duration](types/Duration.md) |
| Publication           | [Publication](types/Publication.md), [PublicationAcknowledged](types/PublicationAcknowledged.md)                                                                                                                                                                                                       |
| Unsubscription        | [Unsubscribe](types/Unsubscribe.md), [Unsubscribed](types/Unsubscribed.md)                                                                                                                                                    |
| Clock estimation      | [ClockRequest](types/ClockRequest.md), [ClockResponse](types/ClockResponse.md)                                                                                                                                                                        |

Wire definitions cover [primitives](encoding/primitives.md), [messages on either channel](encoding/messages.md) and [sample publication bodies](encoding/publication.md).
The [operator binding](bindings/operator.md) defines the current WebRTC and source-quality policies.
[Worked examples](encoding/examples.md) and [specification vectors](testdata/specification-v1.json) provide exact bytes.
