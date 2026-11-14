# Subscription

The client sends [Subscribe](../types/Subscribe.md) on the reliable channel.
It chooses an id, a selection from one group, a channel and a publication schedule.
All four combinations of Reliable/Unreliable and Periodic/OnChange are supported by the protocol.

At most one Subscribe or Unsubscribe operation is pending for a given id.
Different ids can have independent pending requests.
Responses identify requests by subscription id without an additional request identifier.

## Acceptance

The server checks that the group and selected descriptors exist, that the descriptors belong to the group, and that the formats and spaces are supported.
It validates the channel and schedule, then decides whether it can serve the request.
Servers can apply resource and admission limits, including a publication-rate cap; an acquisition group's advertised rate is not itself a protocol-wide publication limit.
For unreliable delivery, the maximum publication body plus its one-byte tag must fit the transport's message limit.

The server sends [SubscriptionAccepted](../types/SubscriptionAccepted.md), binding the requested selection, channel and schedule to the id.
It SHOULD immediately initiate publication of the current state without waiting for client acknowledgment.
The initial acquisition may already exist when the request is accepted.
Subsequent publications follow the [schedule](08-scheduling.md).

## Rejection

A readable request that cannot be fulfilled receives [SubscriptionRejected](../types/SubscriptionRejected.md), preferably with a reason.
Rejection leaves any existing subscription with the same id unchanged.
An entry referencing an unknown descriptor cannot be structurally decoded because its kind determines its length; such malformed control ends the connection.

Next: [publication](04-publication.md), [replacement](05-replacement.md) or [schedule changes](08-scheduling.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0025](../../design/requirements/protocol/PRO-0025.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
