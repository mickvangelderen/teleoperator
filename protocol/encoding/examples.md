# Wire examples

Hexadecimal byte strings below include all protocol bytes, excluding the underlying transport's framing and headers.
Control examples include the four-byte record length.
Tracking examples do not have a length prefix.

## Version offer

The client offers only version `1`.
The body is one tag byte, a four-byte list count, and a two-byte version, for seven bytes.
The whole record is 11 bytes.

```text
07 00 00 00
01
01 00 00 00
01 00
```

The server selects version `1`; this record is seven bytes:

```text
03 00 00 00
02
01 00
```

## Subscription request and acceptance

Assume capabilities advertise these descriptors in group `0`:

| Descriptor index | Kind | Selected format |
| --- | --- | --- |
| 0 | `pressed` | `bit` |
| 1 | `press_count` | `u8` |
| 2 | `trigger` | `unorm8` |

The client requests id `7`, group `0`, rate `60` Hz, and all three selections in that order.
Each non-pose selection has an absent reference space, encoded `00`.
The record is 39 bytes, including its four-byte length of `35` (`0x23`):

```text
23 00 00 00
04
07 00 00 00
00 00 00 00
00 00 70 42
03 00 00 00
00 00 00 00 01 00
01 00 00 00 02 00
02 00 00 00 0c 00
```

The server accepts id `7` with generation `2`; this record is 13 bytes:

```text
09 00 00 00
05
07 00 00 00
02 00 00 00
```

## All three values available

At acquisition time `1,000,000,000` ns, the button is pressed, its press count is `254`, and the trigger's encoded value is `128` (`128/255` when decoded).
Availability is `07`, the boolean section is `01`, and numeric values are `fe 80`.
The packet is 20 bytes:

```text
07 00 00 00
02 00 00 00
00 ca 9a 3b 00 00 00 00
07
01
fe 80
```

## The boolean is unavailable

At acquisition time `1,020,000,000` ns, the button state is unavailable, the press counter is `1`, and the trigger is a valid zero.
Availability is `06`; there are no available booleans and therefore no boolean section.
The packet is 19 bytes:

```text
07 00 00 00
02 00 00 00
00 f7 cb 3c 00 00 00 00
06
01 00
```

The observed press count advanced by three modulo `256` despite the current boolean being unavailable.
An unavailable button state is not equivalent to an available released state.
If all three values were unavailable, this layout would use 17 bytes: the 16-byte header and one zero availability byte.

## Payload-size calculation

For one group containing two `f32` poses, four `bit` inputs, and four `u16` counters, with every value available:

```text
header                 16 bytes
availability for 10     2 bytes
boolean values for 4    1 byte
two poses              56 bytes
four counters           8 bytes
total                  83 bytes
```

At 90 publications per second, the tracking protocol contributes 7,470 bytes per second for this subscription, before transport overhead.
This is an illustrative size calculation, not an entropy measurement or a realistic-recording benchmark.
See [required empirical verification](../derivation.md#verification-still-required).
