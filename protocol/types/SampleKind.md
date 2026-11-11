# SampleKind

A `u8` tag defining a sample's semantics and component count.
All components of one sample use the selected [SampleFormat](SampleFormat.md).

| Kind | Value | Components | Permitted formats | Meaning and component order |
| --- | --- | --- | --- | --- |
| invalid | `0x00` | — | None | Never valid. |
| `generic` | `0x01` | 1 | Any defined valid format | Scalar without protocol-defined semantics. |
| `pressed` | `0x02` | 1 | `bit` | Whether the control is pressed. |
| `press_count` | `0x03` | 1 | `u8`, `u16`, `u32`, `u64` | Cumulative observed press edges. |
| `release_count` | `0x04` | 1 | `u8`, `u16`, `u32`, `u64` | Cumulative observed release edges. |
| `touched` | `0x05` | 1 | `bit` | Whether the control is touched. |
| `touch_count` | `0x06` | 1 | `u8`, `u16`, `u32`, `u64` | Cumulative observed touch edges. |
| `untouch_count` | `0x07` | 1 | `u8`, `u16`, `u32`, `u64` | Cumulative observed untouch edges. |
| `trigger` | `0x08` | 1 | `unorm8`, `unorm16`, `f32`, `f64` | Actuation in `[0, 1]`: released `0`, fully pressed `1`. |
| `thumbstick` | `0x09` | 2 | `snorm8`, `snorm16`, `f32`, `f64` | `(x, y)` in `[-1, 1]` per axis; centered `(0, 0)`, positive X right, positive Y up. |
| `pose` | `0x0A` | 7 | `f32`, `f64` | Position `(x, y, z)` in meters, then unit quaternion `(x, y, z, w)`, relative to the selected reference space. |
| reserved | `0x0B`–`0xFF` | — | None | Forbidden in this version. |

Floating trigger and thumbstick values MUST be finite and within their defined ranges.
Pose components MUST be finite and the quaternion MUST represent a unit rotation, allowing rounding from the selected floating representation.
If the source cannot supply a valid value, mark that sample unavailable.
The `generic` kind imposes no additional numerical semantics beyond its format, including for IEEE floating values.

See [ReferenceSpace](ReferenceSpace.md), [counter behavior](../interactions/04-tracking.md), and [tracking encoding](../encoding/tracking.md).

Source: [PRO-0011](../../design/requirements/protocol/PRO-0011.md).
