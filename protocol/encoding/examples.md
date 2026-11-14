# Wire examples

These bytes exclude transport headers.
Reliable examples include the four-byte record length and one-byte tag.
Unreliable examples include a one-byte tag followed by the payload.
The full [vector set](../testdata/specification-v1.json) is checked by [verify-specification.py](../tools/verify-specification.py).

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
Request subscription 7 using Unreliable delivery, a requested rate of 60 Hz, and formats bit, u8 and unorm8 (40 bytes):

```text
24 00 00 00 04 07 00 00 00 00 00 00 00 01 00 00 70 42 03 00 00 00 00 00 00 00 01 00 01 00 00 00 02 00 03 00 00 00 0c 00
```

Accept with generation 2 (13 bytes):

```text
09 00 00 00 05 07 00 00 00 02 00 00 00
```

## Publication

At acquisition time 1,000,000,000 ns, the button is true, its count is 254, and the encoded trigger is 128/255.
The unreliable message is 21 bytes:

```text
09 07 00 00 00 02 00 00 00 00 ca 9a 3b 00 00 00 00 07 01 fe 80
```

At 1,020,000,000 ns, the boolean is unavailable, the count is 1, and the trigger is a valid zero (20 bytes):

```text
09 07 00 00 00 02 00 00 00 00 f7 cb 3c 00 00 00 00 06 01 00
```

The counter advanced by three modulo 256 despite the boolean being unavailable.
Reliable delivery wraps the same publication body in record tag 0x09, adding five bytes.
The reliable rest-pose vector exercises this framing with f32 and f64 poses and a revision counter.

## Optional references

`ff ff ff ff` is an absent optional index.
`00 00 00 00` is a present reference to element zero.
The capabilities vectors include input-counter references, shared confidence, rest-pose references, revision targets and the parent reference space.

## Clock exchange

ClockRequest 42 on the unreliable channel (5 bytes):

```text
0a 2a 00 00 00
```

ClockResponse 42 on the unreliable channel, with server receive time 1,200 ns and send time 1,300 ns (21 bytes):

```text
0b 2a 00 00 00 b0 04 00 00 00 00 00 00 14 05 00 00 00 00 00 00
```

If the client sent at 1,000 ns and received at 1,300 ns, the estimated server-minus-client offset is 100 ns and round-trip delay is 200 ns.
A server acquisition timestamp of 1,150 ns maps to client time 1,050 ns.

## Payload size

For two f32 poses, four bit inputs and four u16 counters, all available:

```text
header                 16 bytes
availability for 10     2 bytes
boolean values for 4    1 byte
two poses              56 bytes
four counters           8 bytes
publication body       83 bytes
unreliable message     84 bytes
reliable record        88 bytes
```

At 90 publications per second, the unreliable messages total 7,560 bytes per second and the reliable records total 7,920 bytes per second before transport overhead.
These are size calculations, not measurements of realistic-recording entropy.
