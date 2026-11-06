---
name: requirement-extract
description: Extract high-level requirements from user feedback or selected code that have not been explicitly recorded.
---

# Extract requirements

Identify undocumented requirements expressed in the selected source or implied by its behavior.
Propose wording for the user to review and add.

## Process

The process for requirement extraction is as follows:

1. resolve the source;
2. extract candidate requirements;
3. for each candidate:
   1. evaluate candidate;
   2. if evaluation passes:
      1. refine candidate;
      2. amend report;

## Source

Resolve the source for requirement candidate extraction from the user's request.
If the source can not be resolved, ask the user if they meant all code in this repository excluding test. 

Freely inspect other material such as releted code, tests, history, documentation, and conversation context.
Supporting context must not become an independent source of additional candidates.

When using conversation context, distinguish user statements and decisions from unaccepted assistant suggestions.

## Extract

Maintain a record of candidate requirements that can survive compaction in a temporary file.
Avoid evaluating candidates at this stage, keep the records lean.

For large selections, examine the source in manageable sections.

## Evaluate

A requirement states an outcome, constraint or priority that the user would care about even if the implementation were completely rewritten.

For each candidate, ask:

- is this candidate new, or is it already largely covered by an existing requirement?
- would the user object if this changed while everything else stayed acceptable?
- is it a deliberate decision, or an accident of the current code?

Drop candidates that fail these questions.

## Refinement

After the cheap early evaluation pass the requirement can now undergo deeper investigation if needed.

## Report

Write the report to `.agents/reports/design-extract/<yyyy>-<mm>-<dd>-<title>.md.
Make sure not to overwrite existing reports, use a different title instead.

Group candidates by target file: an existing topic file under `design/requirements/`, or a proposed new topic file with a one-line scope for the index.

For each suggestion give:

- proposed wording, short and in the style of the existing requirements;
- whether the user stated it (quote and cite) or you inferred it (cite the evidence), and so whether the user needs to confirm it;
