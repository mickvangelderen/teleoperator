# Version 3 wire examples

These synthetic vectors illustrate [PROTOCOL.md](PROTOCOL.md). Hexadecimal bytes
are in transmission order; whitespace and line breaks are not transmitted. They
exercise the wire rules, not the recorded-realistic-data efficiency verification
requested by PRO-0001. Sizes below exclude transport overhead.

## Negotiation and discovery

A v3-only ClientHello, seven bytes:

```hex
01 58 52 50 42 01 03
```

An accepting v3-only ServerHello, nine bytes. The last zero is the empty reason:

```hex
02 58 52 50 42 01 03 03 00
```

The following complete 110-byte capability catalog advertises catalog 1, four
subscriptions, a 1,024-byte tracking limit, no spaces, and one group. The group
has a maximum acquisition rate of 200 Hz, publication range 1–200 Hz, and default
100 Hz. Five descriptors in group 0 have empty display names and no extensions.
The two counters have description `button`, identifying their associated input;
other descriptions are empty. These short IDs are illustrative device-stable
identifiers:

| Index | ID | Kind | Supported format |
| --- | --- | --- | --- |
| 0 | `button` | pressed | bit |
| 1 | `trigger` | trigger | unorm8 |
| 2 | `stick` | thumbstick | snorm8 |
| 3 | `presses` | press_count | u16 |
| 4 | `releases` | release_count | u16 |

```hex
03 01 04 80 08 00 01
00 00 48 43 00 00 80 3f 00 00 48 43 00 00 c8 42
05
06 62 75 74 74 6f 6e 00 00 02 01 01 00 00
07 74 72 69 67 67 65 72 00 00 08 01 0c 00 00
05 73 74 69 63 6b 00 00 09 01 0e 00 00
07 70 72 65 73 73 65 73 00 06 62 75 74 74 6f 6e 03 01 03 00 00
08 72 65 6c 65 61 73 65 73 00 06 62 75 74 74 6f 6e 04 01 03 00 00
00
```

## Selection determines the layout

Subscribe request 1 assigns subscription ID 7, selects catalog 1/group 0 at
100 Hz, and selects descriptors 0, 1, and 2 in that order. Counters are advertised
but not selected:

```hex
04 01 07 01 00 00 00 c8 42 03 00 01 01 0c 02 0e
```

SubscriptionAccepted is identical except its first byte is `05`. It establishes
revision 1. The layout is:

| Bits, inclusive | Meaning |
| --- | --- |
| 0–2 | Validity of button, trigger, stick |
| 3 | Button state |
| 4–11 | Trigger's unorm8 raw value |
| 12–19 | Stick X's snorm8 raw value |
| 20–27 | Stick Y's snorm8 raw value |
| 28–31 | Zero padding |

With all three valid, button pressed, trigger raw 128, stick X raw 127, and
stick Y raw -127 (two's complement `81`), the packed values are:

```hex
0f f8 17 08
```

The decoded trigger is `128 / 255`, approximately 0.502; the stick is `(1, -1)`.
A complete snapshot at acquisition sequence 42 and timestamp 1,000,000 ns is
15 bytes: three one-byte varints, eight timestamp bytes, and four value bytes.
There is no tracking tag or value-length prefix:

```hex
07 01 2a 40 42 0f 00 00 00 00 00 0f f8 17 08
```

If the button is valid and released, the trigger is unavailable, and the stick
is still `(1, -1)`, the packed values are `05 f0 17 08`. The trigger's validity
bit and its whole slot are zero. If all three values are valid zeros, the packed
values are `07 00 00 00`. If all are unavailable, they are `00 00 00 00`.
These cases are distinct despite several zero component slots.

## Floating-point values are also bit-packed

A different accepted layout selecting just one `pose/f32` has 225 meaningful
bits: one validity bit and seven 32-bit components. It occupies 29 bytes.
For a valid origin pose with identity quaternion `(0, 0, 0, 1)`, the value bytes
are below. The first three lines each contain eight bytes; the last contains five:

```hex
01 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00
00 00 00 00 00 00 00 00
00 00 00 7f 00
```

The `w` component's binary32 pattern is `3f800000`, beginning at bit 193, so its
bits cross the usual byte boundary. A receiver must extract that 32-bit pattern
before interpreting it as a float; it cannot cast the payload to seven floats.
Bit 224 belongs to the final component; bits 225–231 are zero padding.

## Replacement under loss and reordering

Suppose ID 7/revision 1 is active and request 2 selects a different format or
subset for the same subscription ID. Both layouts might have the same byte size.

| Event at client | Required behavior |
| --- | --- |
| Send Subscribe request 2, subscription 7 | Keep revision 1 active while pending. |
| Receive snapshot `(7, 2)` before acceptance | Discard; never infer its layout from its length. |
| Receive snapshot `(7, 1)` before acceptance | May apply if it is newer for revision 1. |
| Receive SubscriptionAccepted request 2 | Replace interpretation with revision 2 atomically; establish new baselines. |
| Receive delayed snapshot `(7, 1)` | Discard, even if its sequence is larger. |
| Receive snapshot `(7, 2)` | Decode solely using revision 2 and its catalog. |
| Later request 3 is rejected | Revision 2 and its existing baselines remain active. |
| Unsubscribe request 4 is processed | Server returns Ended `(request=4, id=7, revision=2, reason=00)`. |
| Request 5 reuses subscription ID 7 | Its accepted revision is 5, so queued revisions 1 and 2 cannot alias it. |

Losing the first snapshot of any revision has no effect on decoding the next.
The server never waits for the client to acknowledge acceptance.

## Counter arithmetic and size bounds

An `u8` counter moving from 254 to 1 has delta `(1 - 254) mod 256 = 3`, provided
fewer than 256 increments elapsed. A duplicate or reordered older acquisition
must not apply that delta again. The same wire values could also hide 259 edges;
the format cannot disambiguate multiple wraps. A first observation of 254 is a
baseline, not 254 actions.

For one-byte subscription ID, revision, and acquisition sequence, the tracking
header is 11 bytes. It grows as those varints grow; capacity checks reserve ten
bytes for the acquisition sequence.

| Selected values | Meaningful value bits, including validity | Value bytes | Packet bytes with an 11-byte header |
| --- | ---: | ---: | ---: |
| 16 Boolean values | 32 | 4 | 15 |
| Button, trigger, stick above | 28 | 4 | 15 |
| One f32 pose | 225 | 29 | 40 |
| 70 f32 joint poses | 15,750 | 1,969 | 1,980 |

These are encoding sizes, not measured entropy or bandwidth claims. The joint
count and rates in the examples are not protocol defaults.

## Interoperability cases for a future codec

In addition to the vectors above, implementations should cover these boundaries:

| Case | Expected result |
| --- | --- |
| `uvar` `00`, `7f`, `80 01`, `ff ff ff ff ff ff ff ff ff 01` | Decode 0, 127, 128, and 2^64 - 1 exactly. |
| `80 00`, `81 00`, a truncated `80`, or a tenth varint byte `02` | Reject noncanonical, truncated, or overflowing encoding. |
| Signed integer minima/maxima, u64 above 2^53, f64 at unaligned offsets | Preserve the exact bit pattern. |
| unorm raw 0/max and snorm raw min/-max/0/max | Decode endpoints by the specified formulas, including the two snorm representations of -1. |
| Validity cleared but a component bit set | Discard the entire snapshot; do not advance ordering state. |
| Nonzero tail padding, extra bytes, or a truncated value slot | Discard the entire snapshot. |
| Non-finite valid float, out-of-range trigger/stick, or invalid quaternion norm | Discard the entire snapshot. |
| Unknown selected format or mixed-group selection | Reject the request with an explanation; retain any prior subscription. |
| Wrong-direction control, unmatched acceptance, or reused request ID | Terminate the connection. |
| Unknown extension with a valid length | Skip it without changing core interpretation. |
| Unknown core kind/format in capabilities | Terminate; widths cannot be guessed. |
| Request for a superseded catalog | Reject as stale; do not reinterpret its indices in the current catalog. |
| New catalog while old subscriptions remain active | Retain their old catalog metadata and byte limits. |
| Recenter | Stop affected old-frame publication; send new catalog then Ended; require a fresh acceptance. |
| Two subscriptions selecting the same group acquisition | Observe the same sequence/time; each uses its own selected layout and quantization. |
| Disconnect, then reuse every numeric ID on a new connection | Negotiate and rediscover; no old callback or packet can update new state. |
