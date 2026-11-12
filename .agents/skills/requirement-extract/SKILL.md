---
name: requirement-extract
description: Extract high-level requirements from user feedback or selected code that have not been explicitly recorded.
---

# Extract requirements

Identify undocumented requirements expressed in the selected source or implied by its behavior.
Propose wording for the user to review and add.

## Process

The process for requirement extraction is as follows:

1. claim an output folder;
2. resolve the source;
3. extract candidate requirements;
4. for each candidate:
   1. evaluate candidate;
   2. if evaluation passes:
      1. refine candidate;
      2. emit requirement;
5. emit report
6. respond

## Claim

Depending on the context, claim a new output folder under `.agents/reports/requirement-extract/<yyyy>-<mm>-<dd>-<title>/` by creating it without overwriting, or if a revision is intended by the user to a report from the same chat conversation re-use that folder.
If folder creation fails, use a different title.

## Source

Resolve the source for requirement candidate extraction from the user's request.
If the source can not be resolved, ask the user if they meant all code in this repository excluding test.

Freely inspect other material such as releted code, tests, history, documentation, and conversation context.
Supporting context must not become an independent source of additional candidates.

When using conversation context, distinguish user statements and decisions from unaccepted assistant suggestions.

## Extract

For large source sets, examine the sources in manageable sections.
Maintain a record of candidate requirements under `.agents/reports/requirement-extract/<yyyy>-<mm>-<dd>-<title>/candidates/<id>.md` that can survive compaction in a temporary file.
Avoid evaluating candidates or diving particularly deep into the details at this stage, keep the records lean.
The intention is to identify broad possibilities before narrowing them down based on the evaluation rules.

## Evaluate

A requirement states an outcome, constraint or priority that the user would care about even if the implementation were completely rewritten.

For each candidate, ask:

- is this candidate new, or is it already largely covered by an existing requirement?
- would the user object if this changed while everything else stayed acceptable?
- is it a deliberate decision, or an accident of the current code?

Drop candidates that fail these questions.

## Refinement

After the cheap early evaluation pass the requirement can now undergo deeper investigation if needed.
The requirement can then be formatted according to the [requirement template](../../../design/requirements/TEMPLATE.md.mustache) under `.agents/reports/requirement-extract/<yyyy>-<mm>-<dd>-<title>/proposed/<id>.md`.

## Report

Write the report to `.agents/reports/requirement-extract/<yyyy>-<mm>-<dd>-<title>/README.md`.

Provide a summary of the proposed requirements.
Group proposals by project if needed.

For each proposal give:

- why this requirement is valid and essential;
- whether the user stated it (quote and cite) or you inferred it (cite the evidence), and so whether the user needs to confirm it;

## Respond

Briefly describe what was extracted and can be found in the report, and link to it.

Present a code block with removal commands per removed requirement (if any), and a copy command to overwrite the remaining requirements.
