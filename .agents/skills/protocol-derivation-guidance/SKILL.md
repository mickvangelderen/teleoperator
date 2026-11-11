---
name: protocol-derivation-guidance
description: Guidance for deriving or revising the teleoperation tracking protocol specification from its hand-written requirements in `design/requirements/`.
---

Write the protocol to `<repo>/protocol`.

Organize the specification as follows:

1. introduction: high level end-user oriented feature description and motivation]
2. describe transport requirements and the protocol at a high level, link forward to types and encoding definitions
  1. describe specific interations in a logical order, each in their own file
4. reference
  1. define each type in it's own file `types/<type>.md`
  2. wire format encoding, split into files where reasonable

When defining or changing the protocol, include only functionality explicitly required by `design/requirements/`.

Permissive wording such as "can" or "may" does not independently justify adding functionality or a generic mechanism.

Missing pieces can be identified and added later.
This avoids the work of removing or refactoring speculative functionality later.
