# ReferenceSpace

A `u8` identifying the coordinate frame of a pose.

| Space         | Value  | Semantics                                                                                                           |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| invalid       | `0x00` | Never valid.                                                                                                        |
| `view`        | `0x01` | Origin and orientation follow the primary viewer's view frame, using the centroid of the view origins for stereo.   |
| `local`       | `0x02` | World-locked, gravity-aligned frame with an origin and initial heading established by the runtime.                  |
| `stage`       | `0x03` | Origin at the floor centre of the runtime-defined rectangular play area.                                            |
| `local_floor` | `0x04` | Same orientation and horizontal origin as `local`, with the vertical origin at the runtime's estimated floor level. |
| `parent`      | `0x05` | Parent joint's corresponding pose frame, resolved through the skeleton mapping ([Joint](Joint.md)).                 |
| reserved      | *      | Reserved for future use.                                                                                            |

A selection uses a space advertised by its pose descriptor.
Position is in meters, and orientation rotates from the source frame into the selected frame.
Coordinates use the right-handed convention of the named OpenXR spaces: positive Y up, positive X right and negative Z forward in the defining orientation.

Requirements: [PRO-0015](../../design/requirements/protocol/PRO-0015.md).
