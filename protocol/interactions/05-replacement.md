# Subscription replacement

A client replaces a subscription by sending a complete [Subscribe](../types/Subscribe.md) with the same id.
Changing selection or channel requires this full request; changing only the schedule uses [UpdateSchedule](../types/UpdateSchedule.md).
The existing subscription remains active while a replacement is pending unless the server separately terminates it.
A rejection leaves the existing subscription unchanged.

For an accepted replacement, the server:

1. Stops publication for the previous subscription.
2. Sends [Unsubscribed](../types/Unsubscribed.md) with a replacement reason if it was active.
3. Sends [SubscriptionAccepted](../types/SubscriptionAccepted.md) for the new request.
4. Starts publication using the new selection, channel and schedule.

The client preserves the pending replacement when receiving the old subscription's ending notification.
Reliable publications are ordered with those notifications and acceptance.

## Unreliable id reuse

Publications carry only the subscription id; there is no generation field.
A delayed unreliable publication from the previous subscription can arrive after the replacement's acceptance.
It cannot be distinguished from a new publication by id alone, and an old payload may happen to be valid under a different selection.
Acquisition timestamps cannot establish a reliable replacement boundary because an initial publication can use an older acquisition.

Clients needing unambiguous interpretation across unreliable selection or channel changes SHOULD use a fresh subscription id and unsubscribe the old id.
They should avoid reusing such ids during the connection.
Same-id replacement is supported, but does not guarantee isolation from delayed unreliable publications.
The protocol adds no acknowledgments, drain handshake or speculative timestamp cutoff to overcome this limit.

Requirements: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0005](../../design/requirements/protocol/PRO-0005.md), [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
