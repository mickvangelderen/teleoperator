# Publication timing

The subscription's `interval`, `phase` and `prediction_offset` govern both channels and all bundles.
Acceptance SHOULD initiate publication immediately, without waiting for an acknowledgment.
If no acquisition exists, the initial publication waits for one.
After that initial opportunity, publication uses scheduled slots; a change marks a bundle pending without bypassing the interval.
For an immediate first publication outside the slot grid, use its publication opportunity time `t` as the timing reference and request target `t + prediction_offset`.
If it waits for the first acquisition, `t` is the opportunity time when that acquisition becomes available.
This request never substitutes for the actual device target in `predicted_for`.
An initial publication exactly at a scheduled slot serves that slot.

## Scheduled slots

All durations are integer nanoseconds; phase refers to the [server clock origin](../types/Instant.md).
For server time `t`, the next slot at or after `t` is:

```text
next_publication_time(t) = t + ((phase - t) mod interval)
target_time(t) = next_publication_time(t) + prediction_offset
```

Modulo has a nonnegative result, so phase values are equivalent modulo interval.
Compute without unsigned underflow or overflow.
An unrepresentable next slot or target is unavailable; it must not wrap or become the absence sentinel.

At a due slot, use the latest group acquisition and the [pending bundle rules](04-publication.md#bundle-state).
An unchanged acquisition may be published again with its original acquisition time.
If the server wakes late, serve the most recent elapsed slot once with the latest state and skip earlier missed slots instead of queuing a burst.
Serve each slot at most once; after serving or skipping it, consider only later slots.
The interval does not request an increase in the group's acquisition rate.

`prediction_offset` requests a prediction target; it does not establish the source's actual target.
[Publication.predicted_for](../types/Publication.md) reports that actual target only when available.
No particular device prediction algorithm is prescribed.

## Live schedule changes

[UpdateSchedule](../types/UpdateSchedule.md) atomically replaces the three timing fields in reliable receive order.
It does not repeat the initial-publication step or reset bundle state, acknowledgment history or sequence numbering.
Use the next slot at or after processing the update under the new timing.
Already submitted messages are not withdrawn, and there is no cross-channel delivery boundary or response message.

## Client timing guidance

Using the client's current server-clock estimate, a desired consumption event can guide timing:

```text
prediction_offset = transit_delay + processing_delay + arrival_margin
scheduled_publication_time = consumption_time - prediction_offset + server_minus_client_offset
phase = scheduled_publication_time mod interval
```

These are estimation hints, not guaranteed latency or prediction accuracy.
See [clock estimation](07-clock-estimation.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md), [PRO-0027](../../design/requirements/protocol/PRO-0027.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md), [PRO-0029](../../design/requirements/protocol/PRO-0029.md).
