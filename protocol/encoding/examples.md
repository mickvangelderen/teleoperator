# Wire examples

Each example is one complete transport message, including its one-byte tag and excluding transport headers.
The [static vectors](../testdata/specification-v1.json) and these bytes are checked by [verify-specification.py](../tools/verify-specification.py).

## Negotiation

Offer version 1 (7 bytes):

```text
01 01 00 00 00 01 00
```

Select version 1 (3 bytes):

```text
02 01 00
```

## Subscription and timing

The fixture advertises a pressed value at descriptor 0, its press counter at 1, and a trigger at 3, all in group 0.
Subscribe id 7 on Unreliable, putting bit, u8 and unorm8 bindings in bundle 0 with no sequence number.
Interval is 16,666,667 ns, phase 5,000,000 ns and prediction offset 25,000,000 ns.
No non-pose binding has a reference-space byte (58 bytes):

```text
04 07 00 00 00 00 00 00 00 01 2b 50 fe 00 00 00 00 00 40 4b 4c 00 00 00 00 00 40 78 7d 01 00 00 00 00 00 01 00 00 00 03 00 00 00 00 00 00 00 01 01 00 00 00 02 03 00 00 00 0c
```

Accept id 7 (5 bytes):

```text
05 07 00 00 00
```

Set interval to 10,000,000 ns, phase to 25,000,000 ns and prediction offset to 9,007,199,254,740,993 ns without changing the layout (29 bytes):

```text
0c 07 00 00 00 80 96 98 00 00 00 00 00 40 78 7d 01 00 00 00 00 01 00 00 00 00 00 20 00
```

Reject id 7 without an explanation (6 bytes):

```text
06 07 00 00 00 00
```

## Continuously included values

At acquisition time 1,000,000,000 ns the button is true, its count is 254, and the trigger is 128/255.
No actual device target time is supplied, so `predicted_for` is absent.
With only bundle 0 and no sequence format, neither a presence bitmap nor a sequence occupies bytes (24 bytes):

```text
09 07 00 00 00 00 ca 9a 3b 00 00 00 00 ff ff ff ff ff ff ff ff 01 fe 80
```

At 1,020,000,000 ns the boolean is false, the count is 1, and the trigger is a valid zero (24 bytes):

```text
09 07 00 00 00 00 f7 cb 3c 00 00 00 00 ff ff ff ff ff ff ff ff 00 01 00
```

The counter advanced by three modulo 256, independently of the current boolean state.

## Acknowledged bundles

Subscription 11 uses u16 sequences and three bundles:

| Bundle | Bindings | Meaning |
| ------ | -------- | ------- |
| 0 | pressed bit, press_count u8 | Always included. |
| 1 | touched bit, trigger unorm8 | Pending until acknowledged. |
| 2 | position_valid bit, release_count u16 | Pending until acknowledged. |

This sequence 65535 publication includes all three bundles.
Presence `03` sets both on-change bundle bits.
Each bundle packs its own booleans before its own numbers: `01 fe`, `00 80`, `01 34 12` (31 bytes):

```text
09 0b 00 00 00 c8 00 00 00 00 00 00 00 ff ff ff ff ff ff ff ff ff ff 03 01 fe 00 80 01 34 12
```

Acknowledging this exact publication uses the unreliable channel, without a sequence-format tag or presence bitmap (7 bytes):

```text
0d 0b 00 00 00 ff ff
```

After wrapping to sequence 0, bundle 1 is omitted and bundle 2 is included.
Presence `02` is followed only by bundle 0 (`00 01`) and bundle 2 (`00 35 12`) (29 bytes):

```text
09 0b 00 00 00 dc 00 00 00 00 00 00 00 ff ff ff ff ff ff ff ff 00 00 02 00 01 00 35 12
```

Acknowledging sequence 65535 after a newer bundle state has been acquired cannot clear that newer state.
If bundle 0 is empty and all other bundles have been acknowledged, the server skips the slot entirely.
The vectors also cover presence crossing a byte boundary, ignored padding bits, u32/u64 sequences, and poses with timestamps beyond `2^53`.

## Clock exchange

ClockRequest 42 (5 bytes):

```text
0a 2a 00 00 00
```

ClockResponse 42 with receive time 1,200 ns and send time 1,300 ns (21 bytes):

```text
0b 2a 00 00 00 b0 04 00 00 00 00 00 00 14 05 00 00 00 00 00 00
```

If the uncorrected client clock reads 1,000 ns when sending and 1,300 ns on receipt, the estimated server-minus-client offset is 100 ns and round-trip delay is 200 ns, assuming timestamp precision at most 200 ns.
A server acquisition at 1,150 ns maps to uncorrected client time 1,050 ns.

## Payload size

For one continuously included bundle containing two f32 poses, four bit inputs and four u16 counters, without a sequence number:

```text
fixed timestamps and id   20 bytes
boolean values for 4      1 byte
two poses                56 bytes
four counters             8 bytes
publication body         85 bytes
message, either channel  86 bytes
```

At 90 publications per second, messages total 7,740 bytes per second before transport overhead.
For multiple bundles, add the selected sequence width and bundle presence bitmap, then the separately packed bodies of included bundles.
These are size calculations, not measurements of realistic-recording entropy.
