# Subscription

The client sends [SubscriptionRequest](../types/SubscriptionRequest.md) over control, choosing an id, one advertised group, a publication rate, and an ordered list of sample selections.
Each selection names a descriptor, one advertised format, and, for a pose, one advertised reference space.
Request order becomes value order in tracking packets.

The client MUST have at most one unanswered subscription request per id.
It waits for that request's acceptance or rejection before sending another subscription request or an unsubscription for that id.
Different ids can have independent pending requests.
Responses identify the id; no separate request identifier is needed.

## Validation and acceptance

The server MUST validate the entire request before changing an existing subscription:

- The group exists and all selected descriptors belong to it.
- The selection is nonempty and contains no repeated descriptor.
- Every format is advertised and permitted for the descriptor's kind.
- Each pose selects an advertised reference space; non-pose selections use the absent marker.
- The requested publication rate is finite, positive, and no greater than the group's maximum acquisition rate.
- The server can support the requested rate, representations, and maximum tracking packet size.

If the request is accepted, the server sends [SubscriptionAccepted](../types/SubscriptionAccepted.md) with the id and a fresh generation.
Acceptance commits to the entire request exactly; the server MUST NOT silently change sample order, formats, reference spaces, or publication rate.
The request and acceptance together provide the packet interpretation metadata.

The server starts publication immediately after sending acceptance, using the next available acquisition and the requested publication rate.
No tracking acknowledgement or additional client confirmation is required.
If all selected sources are inactive, publication still conveys that absence through the availability bitmap.

## Publication rate

`publication_rate_hz` is the requested target rate and an upper bound on publication frequency, subject to acquisition and scheduler timing precision.
Publish current acquisitions at that rate when data acquisition is running normally.
If acquisition is slower or interrupted, publish fewer packets; do not replay old acquisitions to reach the target.
Missed publication opportunities are skipped rather than emitted later as a burst.
Acceptance is not a guarantee of network delivery or simultaneous acquisition across groups.

## Rejection

If a readable request cannot be fulfilled, send [SubscriptionRejected](../types/SubscriptionRejected.md) with an explanatory reason.
Examples include an unavailable sample, an unsupported format, an invalid rate, or a packet that would exceed the transport limit.
Rejection creates no subscription and does not itself alter any existing subscription with the same id.

Next: [tracking](04-tracking.md) or [replacement](05-replacement.md).

Sources: [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), and [PRO-0014](../../design/requirements/protocol/PRO-0014.md).
