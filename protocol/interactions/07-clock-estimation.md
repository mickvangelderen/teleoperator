# Clock offset estimation

After version negotiation, [ClockRequest](../types/ClockRequest.md) and [ClockResponse](../types/ClockResponse.md) use the unreliable channel.
The client associates each outstanding request id with its captured send timestamp; ids are never reused within the connection.
Replies without an outstanding request are discarded.

| Timestamp | Observation |
| --------- | ----------- |
| `T1` | Client software clock immediately before sending the request. |
| `T2` | Server `received_at`, captured immediately on receipt. |
| `T3` | Server `sent_at`, captured immediately before submitting the reply. |
| `T4` | Client software clock immediately on receiving the complete reply. |

The server uses the same clock and origin as publication timestamps.
The client software clock estimates server time from local monotonic time, initially with no correction.
Subtract timestamps as signed integers before converting differences to seconds; preserve captured timestamps when the mapping changes.
With local timestamp precision `rho` (the larger of resolution and read time):

```text
residual_offset = ((T2 - T1) + (T3 - T4)) / 2
round_trip_delay = max(rho, (T4 - T1) - (T3 - T2))
```

A positive residual means the client estimate is behind the server.
For an uncorrected client clock, the residual is the estimated server-minus-client offset.
These estimates are affected by path asymmetry and queuing; half the round-trip delay assumes symmetric transit.

## Client guidance

[PRO-0021's client implementation guidance](../../design/requirements/protocol/PRO-0021.md) describes a software clock with persistent phase and rate correction.
Select a low-delay observation for initial alignment, step the applied offset, then discard pre-alignment observations and outstanding exchanges.
For continued discipline, keep a short arrival-ordered history, select low-delay observations newer than the last accepted one, and suppress isolated spikes.
Retain learned rate and pending phase correction across history turnover and response loss; advance the clock before every timestamp capture or controller update.
Compute elapsed update time before replacing that time.
Validate gains at the chosen probe cadence and reinitialize on clock-origin changes.

This is client implementation guidance, not an additional wire exchange or a required estimator algorithm.
Connection loss discards pending requests and the connection's clock estimate.

Requirements: [PRO-0021](../../design/requirements/protocol/PRO-0021.md).
