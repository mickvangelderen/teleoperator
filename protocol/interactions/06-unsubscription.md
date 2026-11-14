# Unsubscription and termination

The client sends [Unsubscribe](../types/Unsubscribe.md) on the reliable channel, identifying the subscription id.
The server stops that subscription and sends [Unsubscribed](../types/Unsubscribed.md) with a reason.
An unknown or already ended id receives an ending notification without affecting other ids.

The server can also terminate a subscription for any reason and send an ending notification.
The client retires the indicated id but preserves a pending replacement request for that id.
Publications for retired ids are discarded.
Reusing an id has the [unordered-packet limitation](05-replacement.md#unreliable-id-reuse).

Connection loss retires all subscription, schedule and pending-operation state.

Requirements: [PRO-0005](../../design/requirements/protocol/PRO-0005.md), [PRO-0024](../../design/requirements/protocol/PRO-0024.md).
