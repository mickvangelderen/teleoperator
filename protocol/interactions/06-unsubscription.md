# Unsubscription and termination

The client sends [UnsubscribeRequest](../types/UnsubscribeRequest.md) over control, identifying an accepted subscription id and generation.
On receipt, the server stops publication for that pair and sends [SubscriptionEnded](../types/SubscriptionEnded.md) with the same pair and an explanatory reason.
If the pair has already ended, the server still sends an ending notification explaining that it is no longer active.
A request for an old generation MUST NOT terminate a newer generation using the same id.

The server can terminate an active subscription at any time for any reason.
It stops generating that subscription's packets and sends `SubscriptionEnded`, identifying the id, generation, and reason.
Examples include device loss, counter continuity loss, or inability to continue the accepted publication settings.

On an ending notification, the client retires only the indicated generation.
It ignores subsequent tracking packets for that generation and treats repeated ending notifications as having no additional effect.
The client can stop consuming the generation immediately when it requests unsubscription.
Late tracking packets do not revive a subscription.

Loss of the connection implicitly ends all subscriptions, even if an ending notification cannot be delivered.
Reconnection starts a new session and requires new subscription requests.

Sources: [PRO-0005](../../design/requirements/protocol/PRO-0005.md) and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
