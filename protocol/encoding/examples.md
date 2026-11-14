# Wire examples

These bytes exclude transport headers.
Reliable examples include the four-byte record length and one-byte tag.
Unreliable examples include a one-byte tag followed by the payload.
The [vector set](../testdata/specification-v1.json) and these byte examples are checked by [verify-specification.py](../tools/verify-specification.py).

## Negotiation

Offer version 1 (11 bytes):

```text
07 00 00 00 01 01 00 00 00 01 00
```

Select version 1 (7 bytes):

```text
03 00 00 00 02 01 00
```

## Subscription

The fixture advertises a pressed value at descriptor 0, its press counter at 1, and a trigger at 3, all in group 0.
Subscribe id 7 on Unreliable, selecting bit, u8 and unorm8 representations.
The periodic schedule has interval 16,666,667 ns, phase 5,000,000 ns and consumption delay 25,000,000 ns.
This record occupies 58 bytes; none of these non-pose entries has a reference-space byte:

```text
36 00 00 00 04 07 00 00 00 00 00 00 00 03 00 00 00 00 00 00 00 01 01 00 00 00 02 03 00 00 00 0c 01 01 2b 50 fe 00 00 00 00 00 40 4b 4c 00 00 00 00 00 40 78 7d 01 00 00 00 00
```

Accept id 7 (9 bytes):

```text
05 00 00 00 05 07 00 00 00
```

Change id 7 to OnChange without changing its selection or channel (10 bytes):

```text
06 00 00 00 0c 07 00 00 00 02
```

Reject id 7 without an explanation (10 bytes):

```text
06 00 00 00 06 07 00 00 00 00
```

## Publication

At acquisition time 1,000,000,000 ns, the button is true, its count is 254, and the encoded trigger is 128/255.
No samples are predicted, so the prediction field is eight ff bytes.
The unreliable message occupies 25 bytes:

```text
09 07 00 00 00 00 ca 9a 3b 00 00 00 00 ff ff ff ff ff ff ff ff 07 01 fe 80
```

At 1,020,000,000 ns, the boolean is unavailable, the count is 1, and the trigger is a valid zero (24 bytes):

```text
09 07 00 00 00 00 f7 cb 3c 00 00 00 00 ff ff ff ff ff ff ff ff 06 01 00
```

The counter advanced by three modulo 256 despite the boolean being unavailable.
Reliable delivery wraps the same publication body in record tag 0x09, adding five bytes.
The vectors also include predicted poses beyond `2^53` ns, model-space poses, f32/f64 rest poses and revision counters.

## Optional values

`ff ff ff ff` is an absent optional index.
`ff ff ff ff ff ff ff ff` is an absent optional Instant or Duration; this value is invalid when the time is required.
Zero is a valid present index or time.
Optional rejection strings instead use a one-byte presence tag.

## Clock exchange

ClockRequest 42 on the unreliable channel (5 bytes):

```text
0a 2a 00 00 00
```

ClockResponse 42, with server receive time 1,200 ns and send time 1,300 ns (21 bytes):

```text
0b 2a 00 00 00 b0 04 00 00 00 00 00 00 14 05 00 00 00 00 00 00
```

If the client sent at 1,000 ns and received at 1,300 ns, the estimated server-minus-client offset is 100 ns and round-trip delay is 200 ns.
A server acquisition timestamp of 1,150 ns maps to client time 1,050 ns.

## Payload size

For two f32 poses, four bit inputs and four u16 counters, all available:

```text
header                 20 bytes
availability for 10     2 bytes
boolean values for 4    1 byte
two poses              56 bytes
four counters           8 bytes
publication body       87 bytes
unreliable message     88 bytes
reliable record        92 bytes
```

At 90 publications per second, the unreliable messages total 7,920 bytes per second and the reliable records total 8,280 bytes per second before transport overhead.
These are size calculations, not measurements of realistic-recording entropy.
