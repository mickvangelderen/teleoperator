# Derivation and verification

## Requirement baseline

This revision derives from the committed requirements at `067f1ed53383a7c3b7fadc715917b175f114e48b`, with the explicit user feedback below.
The protocol remains unpublished version 1; treating earlier draft bytes as incompatible working drafts is a release-policy assumption, not a requirement derived from PRO-0004.
PRO-0026 links PRO-0030, but that requirement file is absent.
No additional prediction policy can be derived from the missing file.

## Wire choices

The requirements prescribe data and interactions; these choices make their representation concrete:

| Choice | Purpose |
| ------ | ------- |
| Fixed bootstrap, version 1, highest common offered version | Negotiate before decoding version-specific messages. |
| Little-endian fixed-width integers, UTF-8 strings and one-byte tags | Provide compact, directly parseable messages. |
| One tag and payload per transport message on either channel | Use transport message boundaries without application reassembly. |
| Periodic tag 1 with three u64 durations; OnChange tag 2 | Encode PRO-0026's interval, phase and consumption delay independently of channel. |
| UpdateSchedule tag 0x0C with id and full schedule, without acknowledgment | Implement the live timing change explicitly required by PRO-0024. |
| One pending Subscribe/Unsubscribe per id | Correlate responses without an extra request identifier. |
| Id-only subscription lifecycle and 20-byte publication header | Follow PRO-0024 and PRO-0028 without an extra generation field. |
| NonMax u64 times and optional prediction time | Encode PRO-0027 through PRO-0029, including absence, without extra flags. |
| Kind-specific selection entries | Omit a non-pose reference-space placeholder as required by PRO-0025. |
| All selected bits packed together, followed by all selected numbers | Give each subscription a fixed complete layout under the feedback override. |
| Kind-specific descriptor tails and optional NonMax indices | Encode required associations without per-field presence tags. |
| u8 presence tag for an optional rejection string | Preserve the optional explanation in PRO-0024. |
| Binary64 quaternion normalization and f32/f64 norm-squared tolerances | Make unit-quaternion representation interoperable. |

These are wire choices and operational details for required behavior and the explicit feedback overrides below.
The discovery flow remains the initial advertisement following negotiation; no capability replacement interaction is specified.
The consideration about unreliable OnChange acknowledgments is not a requirement and is not implemented.

## Feedback overrides

The user's 2026-11-14 feedback changes the working specification without changing the hand-written design:

- Both channels now use one complete tag-and-payload transport message. The reliable length prefix and application reassembly were derived choices, not obligations in PRO-0002. WebRTC already preserves message boundaries. The operator's 65,535-byte limit is a binding/resource policy, not a universal protocol maximum.
- Readers ignore unused bitmap bits. Requiring zero padding and rejecting other padding were derived canonicalization rules, not design requirements. Ordinary writers can still leave those bits zero.
- Every selected sample now has a fixed value representation. The earlier availability bitmap was one derived encoding of absence, not mandated by design. Removing the per-publication absence facility intentionally supersedes PRO-0028's instruction to distinguish unavailable selected samples and PRO-0026's separate availability-change trigger. OnChange now responds to selected values, including selected status values.
- PRO-0006's distinction between missing data and a valid zero remains a semantic goal through explicit server quality/status policy, rather than a universal absence field. A qualified placeholder is not a measured zero. Unfulfillable selections are rejected or terminated; ordinary inactive representations remain complete. This is the user's replacement policy, not a claim of unchanged conformance to the earlier absence-aware requirements.
- The [operator policy](bindings/operator.md) uses existing pose-quality fields, ordinary generic input-activity bits and one confidence-valid bit. These are server-defined samples, not new protocol kinds, descriptor metadata or mandatory conventions for other devices. The confidence bit preserves PRO-0011's source-reported semantics when numeric zero is only a placeholder.
- Fresh monotonic u32 ids remain a simple client policy; practical id exhaustion is not a limitation of normal subscription use. Unsubscription releases active state but does not establish a cross-channel drain barrier. No safe one- or two-RTT reuse guarantee can be derived from PRO-0024 or the independent channels.

The shared envelope and complete-value layout are incompatible with the preceding working-draft bytes. There is no compatibility layer.
The prior constraint to preserve Quest acquisition code remains in effect: schedule metadata reports the existing source target, without adding a prediction algorithm or asserting on-device timestamp accuracy.

## Changes from the earlier draft

- `Subscribe`, `Unsubscribe`, `Unsubscribed` and `Channel` match the current requirement names.
- Selection groups contain ordered entries with a reference-space byte only for poses.
- Publication schedules replace a requested f32 rate; all channel/schedule combinations are independent.
- A live schedule update changes timing without replacing the selection or channel.
- Generation fields are removed; delayed unreliable packets after same-id replacement are inherently ambiguous.
  Clients needing isolation use fresh ids, as described in [replacement](interactions/05-replacement.md).
- Acquisition and clock times use Instant, publications add an optional actual prediction time, and reference spaces include model.
- Rejection reasons are optional on the wire.

## Requirement coverage

| Requirement                                             | Concern                       | Specification                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PRO-0001](../design/requirements/protocol/PRO-0001.md) | Efficient encoding            | [Primitives](encoding/primitives.md), [publication body](encoding/publication.md), [examples](encoding/examples.md).                                 |
| [PRO-0002](../design/requirements/protocol/PRO-0002.md) | Channel delivery              | [Transport](overview.md#channels), [messages](encoding/messages.md), [publication encoding](encoding/publication.md).                         |
| [PRO-0003](../design/requirements/protocol/PRO-0003.md) | Device independence           | [Capabilities](types/Capabilities.md), [SampleDescriptor](types/SampleDescriptor.md).                                                                |
| [PRO-0004](../design/requirements/protocol/PRO-0004.md) | Version negotiation           | [Negotiation](interactions/01-negotiation.md), [bootstrap](encoding/messages.md#bootstrap).                                                          |
| [PRO-0005](../design/requirements/protocol/PRO-0005.md) | Connection state              | [Lifecycle](overview.md#session-lifecycle), [termination](interactions/06-unsubscription.md).                                                        |
| [PRO-0006](../design/requirements/protocol/PRO-0006.md) | Missing versus valid zero | [Values and quality](interactions/04-publication.md#values-and-quality), subject to the [feedback override](#feedback-overrides). |
| [PRO-0007](../design/requirements/protocol/PRO-0007.md) | Selection                     | [SampleSelection](types/SampleSelection.md), [Subscribe](types/Subscribe.md).                                                    |
| [PRO-0008](../design/requirements/protocol/PRO-0008.md) | Input edges                   | [Descriptor references](types/SampleDescriptor.md), [counters](interactions/04-publication.md#counters).                                             |
| [PRO-0010](../design/requirements/protocol/PRO-0010.md) | Formats and wrapping counters | [SampleFormat](types/SampleFormat.md), [counter behavior](interactions/04-publication.md#counters).                                                  |
| [PRO-0011](../design/requirements/protocol/PRO-0011.md) | Semantic kinds                | [SampleKind](types/SampleKind.md).                                                                                                                   |
| [PRO-0012](../design/requirements/protocol/PRO-0012.md) | Acquisition groups            | [SampleGroup](types/SampleGroup.md), [SampleGroupIndex](types/SampleGroupIndex.md).                                                                  |
| [PRO-0013](../design/requirements/protocol/PRO-0013.md) | Descriptor references         | [SampleDescriptor](types/SampleDescriptor.md), [SampleDescriptorIndex](types/SampleDescriptorIndex.md).                                              |
| [PRO-0014](../design/requirements/protocol/PRO-0014.md) | Message flow                 | [Subscription](interactions/03-subscription.md), [replacement](interactions/05-replacement.md), [unsubscription](interactions/06-unsubscription.md). |
| [PRO-0015](../design/requirements/protocol/PRO-0015.md) | Reference spaces              | [ReferenceSpace](types/ReferenceSpace.md).                                                                                                           |
| [PRO-0016](../design/requirements/protocol/PRO-0016.md) | Capability discovery          | [Capabilities](types/Capabilities.md), [discovery](interactions/02-capabilities.md).                                                                 |
| [PRO-0017](../design/requirements/protocol/PRO-0017.md) | Skeletons                     | [Skeleton](types/Skeleton.md).                                                                                                                       |
| [PRO-0018](../design/requirements/protocol/PRO-0018.md) | Joints                        | [Joint](types/Joint.md), [JointIndex](types/JointIndex.md).                                                                                          |
| [PRO-0019](../design/requirements/protocol/PRO-0019.md) | Delivery choice               | [Channel](types/Channel.md), [request](types/Subscribe.md).                                                                      |
| [PRO-0020](../design/requirements/protocol/PRO-0020.md) | NonMax                        | [NonMax](types/NonMax.md).                                                                                                                           |
| [PRO-0021](../design/requirements/protocol/PRO-0021.md) | Clock estimation              | [ClockRequest](types/ClockRequest.md), [ClockResponse](types/ClockResponse.md), [four-timestamp exchange](interactions/07-clock-estimation.md).      |
| [PRO-0024](../design/requirements/protocol/PRO-0024.md) | Subscriptions and live timing | [Subscribe](types/Subscribe.md), [replacement](interactions/05-replacement.md), [UpdateSchedule](types/UpdateSchedule.md). |
| [PRO-0025](../design/requirements/protocol/PRO-0025.md) | Ordered selection | [SampleSelection](types/SampleSelection.md), [SampleSelectionEntry](types/SampleSelectionEntry.md). |
| [PRO-0026](../design/requirements/protocol/PRO-0026.md) | Publication schedules | [PublicationSchedule](types/PublicationSchedule.md), [timing](interactions/08-scheduling.md), [availability-trigger override](#feedback-overrides). |
| [PRO-0027](../design/requirements/protocol/PRO-0027.md) | Server time | [Instant](types/Instant.md). |
| [PRO-0028](../design/requirements/protocol/PRO-0028.md) | Publication and actual prediction | [SamplePublication](types/SamplePublication.md), [encoding](encoding/publication.md), [complete-value override](#feedback-overrides). |
| [PRO-0029](../design/requirements/protocol/PRO-0029.md) | Time intervals | [Duration](types/Duration.md). |

The operator requirements OP-0001 through OP-0003 concern the same packing, fresh-data delivery and device-independence goals.
The current protocol requirements define two independently selectable channels and schedules.

## Verification

[Shared wire vectors](testdata/specification-v1.json) and [worked examples](encoding/examples.md) cover this revision's wire format.
Run `python3 protocol/tools/verify-specification.py` to check the vectors, numeric examples and documentation links against the committed requirement baseline.

The same static corpus exercises the Rust and TypeScript implementations.
The independent Python verifier checks it without depending on either application codec.

The static examples do not establish packing efficiency on realistic recordings or on-device timing.
PRO-0001 requires measurements using representative source data; protocol changes alone do not supply that evidence.
