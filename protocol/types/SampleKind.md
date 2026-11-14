# SampleKind

A `u8` defining the meaning and component count of a sample.
All components use the selected [SampleFormat](SampleFormat.md).

| Kind                  | Value  | Components | Permitted formats                 | Semantics                                                                                                                                  |
| --------------------- | ------ | ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| invalid               | `0x00` |            |                                   | Never valid                                                                                                                                |
| `generic`             | `0x01` | 1          | any                               | Scalar value without protocol-defined semantics                                                                                            |
| `pressed`             | `0x02` | 1          | `bit`                             | Whether a control is pressed                                                                                                               |
| `press_count`         | `0x03` | 1          | `u8`, `u16`, `u32`, `u64`         | Cumulative count of observed press edges                                                                                                   |
| `release_count`       | `0x04` | 1          | `u8`, `u16`, `u32`, `u64`         | Cumulative count of observed release edges                                                                                                 |
| `touched`             | `0x05` | 1          | `bit`                             | Whether a control is touched                                                                                                               |
| `touch_count`         | `0x06` | 1          | `u8`, `u16`, `u32`, `u64`         | Cumulative count of observed touch edges                                                                                                   |
| `untouch_count`       | `0x07` | 1          | `u8`, `u16`, `u32`, `u64`         | Cumulative count of observed untouch edges                                                                                                 |
| `trigger`             | `0x08` | 1          | `unorm8`, `unorm16`, `f32`, `f64` | Trigger actuation normalized to [0, 1], where 0 is fully released and 1 is fully pressed                                                   |
| `thumbstick`          | `0x09` | 2          | `snorm8`, `snorm16`, `f32`, `f64` | Thumbstick displacement (x, y) normalized to [-1, 1] per axis, where (0, 0) is centered, positive X is right, and positive Y is up         |
| `pose`                | `0x0A` | 7          | `f32`, `f64`                      | Position (x, y, z) in meters followed by unit quaternion (x, y, z, w), relative to a reference space ([ReferenceSpace](ReferenceSpace.md)) |
| `revision`            | `0x0B` | 1          | `u8`, `u16`, `u32`, `u64`         | Revision of data in the group identified by `revision_of` ([SampleDescriptor](SampleDescriptor.md)).                                       |
| `position_valid`      | `0x0C` | 1          | `bit`                             | Whether the associated pose's position is valid.                                                                                           |
| `orientation_valid`   | `0x0D` | 1          | `bit`                             | Whether the associated pose's orientation is valid.                                                                                        |
| `position_tracked`    | `0x0E` | 1          | `bit`                             | Whether the associated pose's position is actively tracked.                                                                                |
| `orientation_tracked` | `0x0F` | 1          | `bit`                             | Whether the associated pose's orientation is actively tracked.                                                                             |
| `confidence`          | `0x10` | 1          | `unorm8`, `unorm16`, `f32`, `f64` | Source-reported confidence applicable to the associated poses, in [0, 1].                                                                  |
| reserved              | *      |            |                                   | Reserved for future use                                                                                                                    |

Floating trigger, thumbstick and confidence values must be finite and in their stated ranges.
Pose components must be finite and the quaternion must represent a unit rotation.
The `generic` kind adds no numerical restrictions beyond its format.

## Quaternion encoding

Normalize a valid source quaternion using at least binary64 arithmetic before conversion to the selected format.
For decoded components, compute `norm_squared = x*x + y*y + z*z + w*w` in binary64.
The unit-length validation tolerance is `abs(norm_squared - 1) <= 1e-5` for `f32`, and `<= 1e-12` for `f64`.
A non-finite or zero-norm source quaternion cannot be normalized into a unit rotation.

These checks concern the encoded value.
Pose component validity and tracking state are represented by the referenced quality samples.

Requirements: [PRO-0011](../../design/requirements/protocol/PRO-0011.md).
