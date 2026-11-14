# Unsubscription and termination

The client sends [UnsubscribeRequest](../types/UnsubscribeRequest.md) on the reliable channel, identifying the accepted subscription id and generation.
The server stops that generation and sends [SubscriptionEnded](../types/SubscriptionEnded.md) with a reason.
An already ended generation receives an ending notification without affecting another generation using the same id.

The server can also terminate a subscription and send an ending notification with a reason.
The client retires only the indicated generation.
An ending notification for an old generation does not reject a pending replacement.
Late publications for retired generations are discarded.

Connection loss retires all subscription and pending-operation state.

Requirements: [PRO-0005](../../design/requirements/protocol/PRO-0005.md), [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
