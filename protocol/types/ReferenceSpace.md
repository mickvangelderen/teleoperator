# ReferenceSpace

A `u8` tag identifying the frame in which a pose is expressed.

| Space | Value | Meaning |
| --- | --- | --- |
| invalid | `0x00` | Never a valid reference space. |
| `view` | `0x01` | Origin and orientation follow the primary viewer's view frame, using the centroid of the view origins for stereo. |
| `local` | `0x02` | World-locked, gravity-aligned frame with runtime-established origin and initial heading. |
| `stage` | `0x03` | Origin at the floor centre of the runtime-defined rectangular play area. |
| `local_floor` | `0x04` | Same orientation and horizontal origin as `local`, with vertical origin at the runtime's estimated floor level. |
| reserved | `0x05`–`0xFF` | Forbidden in this version. |

The selected space MUST appear in the pose descriptor's `supported_spaces`.
It applies to that selection for the lifetime of the accepted subscription.
Selecting a different space requires full subscription replacement.
If the pose cannot be located in the selected space for an acquisition, mark it unavailable.

This draft uses the Cartesian right-handed convention underlying the requirements' OpenXR reference spaces.
Positions are in meters; orientations rotate vectors from the tracked source's frame into the selected reference frame.
Reference frame axis conventions follow the named OpenXR spaces, with positive Y up, positive X right, and negative Z forward in the frame's defining orientation.
World-locked frame axes do not continually follow the viewer.
See the [Khronos OpenXR reference guide](https://registry.khronos.org/OpenXR/specs/1.0/refguide/openxr-10-reference-guide.pdf) and the reference-space definitions linked in [PRO-0015](../../design/requirements/protocol/PRO-0015.md).

See [pose component order](SampleKind.md) and [selection encoding](SampleSelection.md).

Source: [PRO-0015](../../design/requirements/protocol/PRO-0015.md).
