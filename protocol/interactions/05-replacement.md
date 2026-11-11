# Subscription replacement

A client replaces a subscription by sending a complete [SubscriptionRequest](../types/SubscriptionRequest.md) with the same client-assigned id.
No field of an accepted subscription changes in place.
The existing subscription remains usable while the request is pending unless separately terminated by the server.

If validation fails, the server sends [SubscriptionRejected](../types/SubscriptionRejected.md), leaving any still-active subscription unchanged.
If validation succeeds, the server performs the replacement as one state change:

1. Stop generating packets for the old generation, if it is still active.
2. Send [SubscriptionEnded](../types/SubscriptionEnded.md) for that generation with a replacement reason.
3. Send [SubscriptionAccepted](../types/SubscriptionAccepted.md) for the new request, using a fresh generation.
4. Start publishing the new generation immediately, as for a new subscription.

If the previous generation ended while the request was pending, acceptance simply creates a new subscription with that id.
An ending notification for the previous generation does not cancel the pending request.

The generation in every tracking packet prevents a delayed packet from being decoded with the replacement's layout.
A client MUST NOT infer generation from the subscription id, packet size, timestamp, or arrival order across channels.
After retiring a generation, discard all packets identifying it.
Packets for the new generation that arrive before its acceptance are also discarded; subsequent packets need no recovery.

Generations are server-assigned nonzero `u32` values, unique across all acceptances in the connection.
They MUST NOT be reused, even if an id is unsubscribed and later reused.
The server ends the connection before exhausting this identifier space.
Generation identifiers are interpretation metadata, not mid-session protocol versions.

Sources: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0005](../../design/requirements/protocol/PRO-0005.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
