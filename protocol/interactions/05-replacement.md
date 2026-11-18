# Subscription replacement

A complete [Subscribe](../types/Subscribe.md) with an active id replaces that subscription if accepted.
Only `interval`, `phase` and `prediction_offset` can be changed through [UpdateSchedule](../types/UpdateSchedule.md).
The existing subscription remains active on the server while replacement is pending unless separately terminated.

## While replacement is pending

Before submitting the replacement request, the client suspends acknowledgments for that id and drops any acknowledgments for it that have not yet been submitted to the transport.
Until the reliable acceptance or rejection arrives, it discards unreliable publications for that id without decoding or applying their values.
New-layout unreliable publications can overtake acceptance, so the previous layout cannot safely interpret them.
Reliable publications received before the response still use the old layout and can be applied, but are not acknowledged while replacement is pending.
No suppressed acknowledgments are replayed after the response.

## Accepted replacement

The server atomically stops the old subscription, discards its bundle and acknowledgment state, and sends [SubscriptionAccepted](../types/SubscriptionAccepted.md) for the new request.
It then starts the new subscription with all on-change bundles pending and its sequence at zero.
Acceptance itself is the replacement boundary on the reliable channel; replacement does not send an additional Unsubscribed notification.
All reliable publications sent before acceptance use the old layout, and all sent after it use the new layout.
The client installs the accepted request, resets receive state, and resumes normal publication and acknowledgment processing.

## Rejection or separate termination

[SubscriptionRejected](../types/SubscriptionRejected.md) leaves the old subscription unchanged if it is still active.
The client resumes processing with the old layout and preserved receive state; subsequent pending-bundle publications repair acknowledgment suppression.

The server can independently terminate the old subscription while a replacement is pending and send [Unsubscribed](../types/Unsubscribed.md).
The client retires the old subscription while preserving the pending request.
Later acceptance installs the new subscription; later rejection leaves no active subscription for the id.
An ending notification is not itself a replacement response.

## Unreliable id reuse

Suppression prevents acknowledgments generated during replacement from confirming a different subscription, but it is not a cross-channel drain barrier.
Already submitted acknowledgments can arrive after the server replaces the subscription.
Delayed publications and acknowledgments carry no subscription generation beyond the id.
After acceptance, an old publication may decode under the new layout, or a pre-request acknowledgment may match a new sequence.
Timestamps and sequence numbers cannot establish a replacement boundary on the unreliable channel.
This acknowledgment ambiguity also applies when publications use the reliable channel.

Clients needing isolation SHOULD use a fresh id and unsubscribe the old id, avoiding reuse during the connection.
Unsubscription releases active state but does not prove that the other channel has drained.
Same-id replacement is supported without a guarantee of isolation from delayed unreliable messages.

Requirements: [PRO-0002](../../design/requirements/protocol/PRO-0002.md), [PRO-0005](../../design/requirements/protocol/PRO-0005.md), [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md).
