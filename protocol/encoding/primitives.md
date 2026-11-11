# Primitive encoding

These rules apply to bootstrap messages and proposed version 1.

| Notation | Encoding |
| --- | --- |
| `u8`, `u16`, `u32`, `u64` | Unsigned fixed-width integer, little-endian for multi-byte values. |
| `i8`, `i16`, `i32`, `i64` | Two's-complement fixed-width integer, little-endian for multi-byte values. |
| `f32`, `f64` | IEEE 754 binary32 or binary64 bit pattern, least-significant byte first. |
| Enum | One `u8` using its type's defined values. |
| `string` | `u32` UTF-8 byte length, followed by exactly that many bytes; no terminator. |
| `list<T>` | `u32` element count, followed by that many consecutive encodings of `T`. |
| Struct | Fields concatenated in the order listed in its type definition. |
| Bitmap | Bit `i` is `(byte[i / 8] >> (i % 8)) & 1`, using integer division. |

There is no implicit alignment or padding between fields, components, strings, or list elements.
A bitmap occupies `ceil(bit_count / 8)` bytes, and unused high bits in its final byte MUST be zero.
A zero-length bitmap occupies no bytes.
List counts count elements; string lengths and control record lengths count bytes.
All counts and lengths use fixed-width integers, not variable-width encodings.

Field-specific rules determine whether zero, an empty list, an empty string, or a non-finite float is valid.
Strings MUST be well-formed UTF-8.
Strings used as ids compare exactly; no case folding or Unicode normalization is applied by the protocol.

Receivers MUST check lengths, counts, arithmetic overflow, and available record bytes before allocating or reading memory.
An implementation's resource bounds can be smaller than the representable wire limits.
A control record exceeding those bounds can end the connection; a readable subscription that cannot be serviced is rejected with a reason.
No decoder may use a wire count as permission to read beyond the containing record.

See [control framing](control.md), [tracking layout](tracking.md), and [normalized sample formats](../types/SampleFormat.md).

Source: [PRO-0001](../../design/requirements/protocol/PRO-0001.md).
