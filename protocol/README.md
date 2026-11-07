# XR tracking protocol

[PROTOCOL.md](PROTOCOL.md) specifies the proposed custom binary protocol,
version 3. It replaces the FlatBuffers schema and the previous protocol design.
The source requirements are in [design/requirements/protocol](../design/requirements/protocol/README.md).

The control channel negotiates the version, advertises acquisition groups and
sample descriptors, and accepts subscriptions. Each subscription selects one
group, individual samples, their formats, and a publication rate. Its accepted
selection determines the bit layout of every tracking snapshot at runtime.

Start with the [wire conventions](PROTOCOL.md#wire-conventions),
[subscription lifecycle](PROTOCOL.md#subscription-lifecycle), and
[packed snapshots](PROTOCOL.md#packed-snapshots).
[EXAMPLES.md](EXAMPLES.md) contains byte-level examples and interoperability cases.
The [requirements review](PROTOCOL.md#requirements-review) separates coverage from
specification choices and unresolved product questions.

## Implementation status

This is a specification draft, not an implemented protocol. The server and Viewer
still contain the old FlatBuffers implementation and have deliberately not been
migrated. `wire.fbs`, the compiler bootstrap, and its tests have been removed;
their existing build/generation hooks therefore cannot build from a clean checkout.
Their documentation describes the previous implementation, including retired
protocol setup links. There is no new generator or codec yet.

Version 3 is incompatible with FlatBuffers v1/v2, including the hello encoding.
A future transport integration must distinguish this protocol before sending its
hello; version negotiation alone cannot make an old FlatBuffers peer decode it.
No changes have been made to the hand-written requirements.
