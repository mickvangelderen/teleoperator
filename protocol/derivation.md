# Derivation and verification

## Requirement baseline

This specification derives from the hand-written requirements at `da17cd684a906ca77ab66aa90912ccdb8ea0d017` and the applicable explicit user instructions below.
The requirements define the protocol's scope; implementation considerations supply guidance rather than extra wire features.

## Concrete choices

| Choice | Basis |
| ------ | ----- |
| Version 1, fixed bootstrap and highest common offered version | PRO-0004 negotiation. |
| Fixed-width little-endian integers, UTF-8 strings and one-byte tags | PRO-0001 compact encoding and direct parsing. |
| One complete tag-and-payload message on either channel | User instruction and message-preserving transport. |
| Subscribe fields in PRO-0024 order; zero for absent sequence format | Direct subscription model and compact optional enum. |
| UpdateSchedule `0x0C`: id and three durations, no response | PRO-0024 live interval, phase and prediction-offset changes. |
| Publication `0x09`; PublicationAcknowledged `0x0D` | PRO-0028 publication and exact acknowledgment. |
| Per-bundle bit section followed by numeric values | PRO-0028 present bundles in order; complete selected values. |
| Kind-specific bindings and descriptor tails | PRO-0013 and PRO-0025 without placeholder fields. |
| NonMax optional indices and times; presence byte for an optional string | PRO-0020, PRO-0024, PRO-0027 and PRO-0029. |
| One pending Subscribe/Unsubscribe per id | Correlate lifecycle responses without another identifier. |
| Encoded-value comparison and exact state acknowledgment | Define observable latest-state behavior; local revisions and history are implementation guidance. |
| Zero initial sequence and modular half-range ordering | Concrete interpretation of PRO-0028's wrapping per-publication sequence. |
| Binary64 quaternion normalization and format-specific tolerances | Interoperable unit rotations for PRO-0011. |

## Feedback overrides

Applicable user instructions are:

- Transport messages contain a single tag and payload, without an application length prefix or reassembly layer.
- Readers ignore unused bitmap bits.
- Included samples always carry complete values; source quality and ordinary status samples distinguish inactive placeholders from measurements.
  This is the explicit interpretation of PRO-0006 used by the [operator policy](bindings/operator.md#source-quality).
  Bundle omission in PRO-0028 expresses delivery state, not per-sample validity.
- Use fresh ids when cross-channel isolation is needed.
  No round-trip count proves that an unreliable channel has drained.

The `/active` and `/valid` naming conventions are binding-specific interpretations of generic samples, not typed protocol associations.
A generic client cannot infer their validity meaning from the descriptor schema alone.

## Requirement boundaries

PRO-0024 and PRO-0028 require scheduled latest-state bundle delivery and exact acknowledgments over the unreliable channel.
Repeating a pending state in a new publication is not transport retransmission of an old message and does not delay a newer acquisition.
The [unreliable on-change consideration](../design/considerations/unreliable-on-change.md) is motivation, not an alternative protocol mode.
The [WebRTC freshness consideration](../design/considerations/webrtc-publication-freshness.md) concerns transport implementation and adds no required lifecycle API or wire messages.

Finite sequence numbers cannot identify arbitrarily delayed messages across a complete wrap or same-id replacement.
The [sequence window](types/SequenceNumberFormat.md) and [fresh-id policy](interactions/05-replacement.md#unreliable-id-reuse) state that limit without adding epochs or a drain handshake.

OP-0002 calls for unordered tracking, while PRO-0019 and PRO-0024 explicitly allow clients to choose reliable publications.
This specification follows those more specific protocol requirements: latency-sensitive data can use Unreliable, and consumers needing ordered guaranteed delivery can select Reliable.
The client clock discipline in PRO-0021 is implementation guidance; the timestamps and request/response behavior are the wire contract.

## Requirement coverage

| Requirement                                             | Concern                       | Specification                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PRO-0001](../design/requirements/protocol/PRO-0001.md) | Efficient encoding            | [Primitives](encoding/primitives.md), [publication body](encoding/publication.md), [examples](encoding/examples.md).                                 |
| [PRO-0002](../design/requirements/protocol/PRO-0002.md) | Channel delivery              | [Transport](overview.md#channels), [messages](encoding/messages.md), [publication encoding](encoding/publication.md).                         |
| [PRO-0003](../design/requirements/protocol/PRO-0003.md) | Device independence           | [Capabilities](types/Capabilities.md), [SampleDescriptor](types/SampleDescriptor.md).                                                                |
| [PRO-0004](../design/requirements/protocol/PRO-0004.md) | Version negotiation           | [Negotiation](interactions/01-negotiation.md), [bootstrap](encoding/messages.md#bootstrap).                                                          |
| [PRO-0005](../design/requirements/protocol/PRO-0005.md) | Connection state              | [Lifecycle](overview.md#session-lifecycle), [termination](interactions/06-unsubscription.md).                                                        |
| [PRO-0006](../design/requirements/protocol/PRO-0006.md) | Missing versus valid zero | [Values and quality](interactions/04-publication.md#values-and-quality), subject to the [feedback override](#feedback-overrides). |
| [PRO-0007](../design/requirements/protocol/PRO-0007.md) | Selection                     | [SampleBinding](types/SampleBinding.md), [Subscribe](types/Subscribe.md).                                                    |
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
| [PRO-0025](../design/requirements/protocol/PRO-0025.md) | Ordered selection | [SampleBinding](types/SampleBinding.md), [Subscribe](types/Subscribe.md). |
| [PRO-0026](../design/requirements/protocol/PRO-0026.md) | Publication schedules | [UpdateSchedule](types/UpdateSchedule.md), [timing](interactions/08-scheduling.md). |
| [PRO-0027](../design/requirements/protocol/PRO-0027.md) | Server time | [Instant](types/Instant.md). |
| [PRO-0028](../design/requirements/protocol/PRO-0028.md) | Publication and actual prediction | [Publication](types/Publication.md), [PublicationAcknowledged](types/PublicationAcknowledged.md), [encoding](encoding/publication.md). |
| [PRO-0029](../design/requirements/protocol/PRO-0029.md) | Time intervals | [Duration](types/Duration.md). |

## Verification

[Wire vectors](testdata/specification-v1.json) and [worked examples](encoding/examples.md) define static expected bytes independently of application codecs.
Run `python3 protocol/tools/verify-specification.py` to check message layouts, bundle presence and value packing, all sequence widths, exact acknowledgment behavior, replacement races, per-bundle ordering, message outcomes, capability references, arithmetic and local documentation links.
The corpus is the handoff contract for Rust and TypeScript implementations.

Static vectors do not establish realistic recording entropy, transport freshness or on-device timing accuracy.
PRO-0001 and OP-0001 still require measurements using representative source recordings.
