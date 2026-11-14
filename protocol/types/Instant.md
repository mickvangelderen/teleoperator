# Instant

`Instant(NonMax<u64>)` is a point on the server's monotonic clock in nanoseconds from a server-defined origin.
All instants within a connection share that clock and origin, including acquisition, prediction and clock-response times.

The encoding is eight little-endian bytes, with valid values from `0` through `18446744073709551614`.
`Option<Instant>` has the same width; `ff ff ff ff ff ff ff ff` means absent.
That sentinel is invalid for a required instant.
Implementations must retain integer precision beyond `2^53`.

Requirements: [PRO-0027](../../design/requirements/protocol/PRO-0027.md), [PRO-0020](../../design/requirements/protocol/PRO-0020.md).
