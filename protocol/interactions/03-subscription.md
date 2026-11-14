# Subscription

The client sends [SubscriptionRequest](../types/SubscriptionRequest.md) on the reliable channel.
It chooses an id, one group, a delivery mode, a requested publication rate and sample representations.

At most one subscription operation is pending for a given id.
Different ids can have independent pending requests.
This lets responses identify requests by subscription id without an additional request identifier.

## Acceptance

The server checks that the group and selected descriptors exist, that the descriptors belong to the group, and that the requested formats and spaces are supported.
It checks the delivery mode and requested rate's numeric representation, then decides whether it can serve the request.
For unreliable delivery, the maximum publication body plus its one-byte tag must fit the transport's message limit.

The server sends [SubscriptionAccepted](../types/SubscriptionAccepted.md) with a fresh generation.
Acceptance binds the requested sample order, formats, reference spaces and delivery mode.
The server should immediately publish the current state of the selected samples after sending acceptance.
The initial acquisition may already exist when the request is accepted.

## Rejection

A readable request that cannot be fulfilled receives [SubscriptionRejected](../types/SubscriptionRejected.md) with a reason.
Rejection leaves any existing subscription with the same id unchanged.

Next: [publication](04-publication.md) or [replacement](05-replacement.md).

Requirements: [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md), [PRO-0019](../../design/requirements/protocol/PRO-0019.md).
