# Capability advertising

After successful version selection, the server sends [Capabilities](../types/Capabilities.md) on the reliable channel.
The client uses the advertisement to construct subscriptions.

Validation checks the defined enum values, numeric formats, list references and kind-specific fields.
Descriptor ids identify unique sources within the advertisement.
Sample references can point forward in the descriptor list, so their targets are checked after the complete advertisement is decoded.
Joint references are checked against their containing skeleton and the global descriptor list.

Edge counters are advertised for inputs whose edges are meaningful, as required by PRO-0008.
Their associations are carried by the input descriptor's optional references.
Quality and revision samples use the same selection mechanism as other samples.

The advertisement establishes the index context used by this session's subscriptions.
Next: [subscription](03-subscription.md).

Requirements: [PRO-0003](../../design/requirements/protocol/PRO-0003.md), [PRO-0007](../../design/requirements/protocol/PRO-0007.md), [PRO-0008](../../design/requirements/protocol/PRO-0008.md), [PRO-0011](../../design/requirements/protocol/PRO-0011.md), [PRO-0012](../../design/requirements/protocol/PRO-0012.md), [PRO-0013](../../design/requirements/protocol/PRO-0013.md), [PRO-0016](../../design/requirements/protocol/PRO-0016.md), [PRO-0017](../../design/requirements/protocol/PRO-0017.md), [PRO-0018](../../design/requirements/protocol/PRO-0018.md).
