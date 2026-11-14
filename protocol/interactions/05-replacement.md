# Subscription replacement

A client replaces a subscription by sending a complete [SubscriptionRequest](../types/SubscriptionRequest.md) with the same id.
The existing subscription remains active while the request is pending unless the server separately terminates it.
A rejection leaves the existing subscription unchanged.

For an accepted replacement, the server:

1. Stops publication for the previous generation.
2. Sends [SubscriptionEnded](../types/SubscriptionEnded.md) for that generation with a replacement reason, if it was active.
3. Sends [SubscriptionAccepted](../types/SubscriptionAccepted.md) for the new request.
4. Starts publication for the new generation.

Generations are nonzero `u32` values, unique across acceptances in the connection.
They are never reused; the connection ends before the identifier space is exhausted.
A delayed publication or termination for an old generation cannot affect its replacement.
Unreliable publications that overtake their acceptance are discarded until that generation is known.

Requirements: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0005](../../design/requirements/protocol/PRO-0005.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
