---
name: protocol-derivation-guidance
description: Guidance for deriving or revising the teleoperation tracking protocol specification from its hand-written requirements in `design/requirements/`.
---

When defining or changing the protocol, include only functionality explicitly required by `design/requirements/`.
Agents may choose wire formats and encoding details necessary to implement those requirements.
Permissive wording such as "can" or "may" does not independently justify adding functionality or a generic mechanism.
Favor keeping the specification as lean as possible.
Missing pieces can be identified and added later.
This avoids the work of removing or refactoring speculative functionality later.
