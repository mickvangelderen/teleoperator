# Duration

`Duration(NonMax<u64>)` is a non-negative interval measured in nanoseconds.
The encoding is eight little-endian bytes, with valid values from `0` through `18446744073709551614`.
`Option<Duration>` has the same width; `ff ff ff ff ff ff ff ff` means absent.
That sentinel is invalid for a required duration.
Field-specific constraints, such as a positive periodic interval, still apply.

Requirements: [PRO-0029](../../design/requirements/protocol/PRO-0029.md), [PRO-0020](../../design/requirements/protocol/PRO-0020.md).
