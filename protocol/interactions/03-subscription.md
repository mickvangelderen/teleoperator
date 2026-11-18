# Subscription

The client sends [Subscribe](../types/Subscribe.md) on the reliable channel.
It chooses an id, one acquisition group, a channel, timing, an optional sequence format and ordered bundles.
Both channels support a continuously included bundle 0 and acknowledged on-change bundles.

At most one Subscribe or Unsubscribe operation is pending for a given id.
Different ids can have independent pending requests.
Responses identify requests by subscription id without an additional request identifier.

## Acceptance

The server checks that the group and selected descriptors exist, that the descriptors belong to the group, and that the formats and spaces are supported.
It validates the channel, positive interval, durations, sequence format and non-empty bundle list, then decides whether it can serve the request.
More than one bundle requires a sequence format.
Servers can apply resource and admission limits, including a publication-rate cap; an acquisition group's advertised rate is not itself a protocol-wide publication limit.
On either channel, the largest publication body with all bundles present plus its one-byte tag must fit the transport's message limit and any smaller negotiated peer limit.
Every selected sample must have a complete supported representation, including any server-defined inactive representation with explicit quality semantics.
If an existing acquisition proves that the selected source or encoding contract cannot be fulfilled, the request is rejected before replacing an active subscription.

The server sends [SubscriptionAccepted](../types/SubscriptionAccepted.md), binding the complete request to the id.
It SHOULD immediately initiate publication of the current state without waiting for client acknowledgment.
The initial acquisition may already exist when the request is accepted.
If none exists, publication waits for an acquisition; acceptance does not manufacture one.
Subsequent publications follow the [schedule](08-scheduling.md).

## Rejection

First validate the request's type constraints and complete encoding under the [invalid-message rules](../overview.md#invalid-messages).
A structurally valid request that cannot be fulfilled receives [SubscriptionRejected](../types/SubscriptionRejected.md), preferably with a reason.
Rejection leaves any existing subscription with the same id unchanged.
A binding referencing an unknown descriptor cannot be structurally decoded because its kind determines its length; such malformed control ends the connection.

Next: [publication](04-publication.md), [replacement](05-replacement.md) or [schedule changes](08-scheduling.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0025](../../design/requirements/protocol/PRO-0025.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md).
