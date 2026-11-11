# Capability advertising

After selecting a version, the server sends one [Capabilities](../types/Capabilities.md) message over control.
It contains an ordered list of acquisition groups and a list of selectable sample descriptors.

The client validates the advertisement before using it:

- Every group has a finite, positive maximum sample rate.
- Descriptor identifiers are nonempty and unique within the advertisement.
- Each descriptor references an existing group.
- Every descriptor has a valid kind and a nonempty set of supported, kind-compatible formats.
- Every pose descriptor has a nonempty set of valid supported reference spaces.

The server MUST advertise press/release or touch/untouch counter descriptors for inputs whose corresponding edges are meaningful.
Each counter is individually selectable, just like an instantaneous input value.
Use the existing `generic` kind for scalar data without standard semantics.
Device-specific names do not require an additional extension mechanism.

Groups and descriptors retain their advertised indices for the session.
If the advertised contract must change, end the connection and advertise the new contract on a new one.
Temporary sample inactivity instead uses tracking availability; the server can also terminate an affected subscription with a reason.

Next: [subscription](03-subscription.md).

Sources: [PRO-0003](../../design/requirements/protocol/PRO-0003.md), [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0008](../../design/requirements/protocol/PRO-0008.md), [PRO-0010](../../design/requirements/protocol/PRO-0010.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md), and [PRO-0016](../../design/requirements/protocol/PRO-0016.md).
