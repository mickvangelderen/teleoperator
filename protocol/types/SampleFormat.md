# SampleFormat

A `u8` tag defining the representation of each component of a sample.
The sample's [SampleKind](SampleKind.md) determines its component count and permitted formats.

| Format | Value | Bits per component | Representation |
| --- | --- | --- | --- |
| invalid | `0x00` | — | Never valid. |
| `bit` | `0x01` | 1 | Boolean, `0` false and `1` true. |
| `u8` | `0x02` | 8 | Unsigned integer. |
| `u16` | `0x03` | 16 | Unsigned integer. |
| `u32` | `0x04` | 32 | Unsigned integer. |
| `u64` | `0x05` | 64 | Unsigned integer. |
| `i8` | `0x06` | 8 | Two's-complement signed integer. |
| `i16` | `0x07` | 16 | Two's-complement signed integer. |
| `i32` | `0x08` | 32 | Two's-complement signed integer. |
| `i64` | `0x09` | 64 | Two's-complement signed integer. |
| `f32` | `0x0A` | 32 | IEEE 754 binary32. |
| `f64` | `0x0B` | 64 | IEEE 754 binary64. |
| `unorm8` | `0x0C` | 8 | Unsigned integer normalized to `[0, 1]`. |
| `unorm16` | `0x0D` | 16 | Unsigned integer normalized to `[0, 1]`. |
| `snorm8` | `0x0E` | 8 | Signed integer normalized to `[-1, 1]`. |
| `snorm16` | `0x0F` | 16 | Signed integer normalized to `[-1, 1]`. |
| reserved | `0x10`–`0xFF` | — | Forbidden in this version. |

For `unorm` width `w`, decode raw integer `n` as `n / (2^w - 1)`.
For `snorm` width `w`, decode signed raw integer `n` as `max(-1, n / (2^(w-1) - 1))`.
Thus both `-128` and `-127` decode to `-1` for `snorm8`.
Canonical encoding multiplies the valid normalized value by the positive denominator and rounds to the nearest integer, ties to even.
It emits `-127`, rather than `-128`, for `snorm8` negative unity, and `-32767` for `snorm16` negative unity.

Invalid source data MUST be marked unavailable instead of being silently converted to a valid endpoint.
All multi-byte values use [little-endian encoding](../encoding/primitives.md).
Boolean components use the packed [tracking boolean section](../encoding/tracking.md).

Source: [PRO-0010](../../design/requirements/protocol/PRO-0010.md).
