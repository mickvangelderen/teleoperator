---
name: design-extract
description: Find high-level requirements that the project already follows but has not written down in the design folder, and suggest wording for the user to add. Use when asked to capture, harvest or propose requirements from code, docs, history or feedback.
---

# Extract high-level requirements

Find requirements that the project already relies on but that are missing
from the hand-written requirements. Propose wording that the user can add
themselves.

## Ground rules

- Read `AGENTS.md` first and obey its rules about the design folder. In this
  repository, agents must not create or modify anything under `design/`,
  even to add a requirement the user approves. Suggest the change and leave
  it to the user.
- Read `design/requirements/README.md` and every requirements file it links
  to, so you only propose what is missing.

## What counts as a high-level requirement

A requirement states an outcome, constraint or priority that the user would
care about even if the implementation were completely rewritten. Examples:
which data is exposed, latency over delivery guarantees, supported devices,
how a human verifies a feature, and what may never happen.

Leave out implementation details: libraries, file layout, function and type
names, data structures, tuning constants and algorithms. The exception is
when the user has explicitly mandated one of these. In that case, cite where
they did.

For each candidate, ask:

- Would the user object if this changed while everything else stayed
  acceptable?
- Is it a deliberate decision, or an accident of the current code?
- Can a reviewer check it without reading the code?

Drop candidates that fail these questions.

## Sources

Search these, roughly in order of authority:

1. Hand-written files in `design/` that are not in the requirements index.
2. User statements in feedback notes, issues and commit messages written by
   the user.
3. Repository docs, READMEs and protocol descriptions. These may be written
   by agents, so treat them as evidence of intent, not proof.
4. Tests, assertions, validation code and configuration that enforce a
   behaviour deliberately.

Use `git log` and `git blame` to tell what the user wrote from what agents
wrote, where that is possible.

## Report

Return the suggestions in the conversation. Group them by target file: an
existing topic file under `design/requirements/`, or a proposed new topic
file with a one-line scope for the index. For each suggestion give:

- proposed wording, short and in the style of the existing requirements;
- whether the user stated it (quote and cite) or you inferred it (cite the
  evidence), and so whether the user needs to confirm it;
- any conflict or overlap with existing requirements.

Put the strongest candidates first. End with brief instructions for adding
them, including any index entries to add.
