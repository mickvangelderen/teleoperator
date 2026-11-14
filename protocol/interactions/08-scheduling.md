# Publication timing

[PublicationSchedule](../types/PublicationSchedule.md) controls timing independently of the selected channel.
A newly accepted subscription starts publication immediately; the schedule governs subsequent publications.

## Periodic

All durations are integer nanoseconds and phase refers to the [server clock origin](../types/Instant.md).
For server time `t`, the next scheduled time at or after `t` is:

```text
next_publication_time(t) = t + ((phase - t) mod interval)
target_time(t) = next_publication_time(t) + consumption_delay
```

Modulo here is mathematical modulo with a nonnegative result.
Phase values are equivalent modulo interval.
Compute differences and additions without unsigned underflow or overflow.
If a next slot or prediction target is beyond the representable Instant range, it is unavailable; it must not wrap to an earlier time or the absence sentinel.

The server schedules publication independently of acquisition notifications, using the latest available group acquisition at a due slot.
An unchanged acquisition can therefore appear in multiple periodic publications with its original acquisition time.
If the server wakes late, it publishes the latest state once and skips missed slots instead of queuing a burst of old samples.
A slot is sent at most once; the next slot after serving a due time is strictly later.
The interval is desired publication timing, not a request to increase the acquisition group's maximum sample rate.

`consumption_delay` communicates the desired prediction target.
The actual prediction time, when predicted values are present, is carried in [SamplePublication.predicted_for](../types/SamplePublication.md).
A server must not label a value as predicted for a requested time unless its source actually represents that time.
If a source uses a fixed prediction horizon, publish its actual target time.

## OnChange

Publish a complete selected snapshot when a selected encoded value or its availability changes from the last publication.
Timestamp changes alone do not trigger publication.
No earlier publication is required to decode the result.

Unreliable OnChange does not retransmit, await acknowledgment or periodically refresh unchanged data.
A lost final change can leave the client stale until another change occurs.
Use Reliable when guaranteed delivery of an unchanged final state is needed, or Periodic when regular fresh snapshots are needed.

## Live schedule changes

The client sends [UpdateSchedule](../types/UpdateSchedule.md) to replace timing for an existing id.
The server applies updates in reliable receive order without changing the selection or channel, or repeating the initial-publication step.
Switching to Periodic follows the next slot in the new schedule.
Switching to OnChange compares against the last published selected values and availability.
Already submitted transport messages are not withdrawn by an update.
There is no response message or cross-channel delivery boundary for this operation.

## Requirement boundary

PRO-0026 references PRO-0030 for consumption delay, but PRO-0030 is absent from this requirement baseline.
This specification defines the provided schedule and actual prediction timestamp without adding an unspecified prediction algorithm or requiring a particular device API change.

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0026](../../design/requirements/protocol/PRO-0026.md), [PRO-0027](../../design/requirements/protocol/PRO-0027.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md), [PRO-0029](../../design/requirements/protocol/PRO-0029.md).
