---
name: requirement-lint
description: Review the requirements folder itself for consistency, duplication, clarity and organisation, and suggest edits for the user to make.
---

# Lint requirements

Review requirements under `design/requirements/`.
Unless specifically requested otherwise, use only files under `design/requirements/` as the review context.
Suggest concrete edits for the user to make.

## Scope

The user may indicate a subset of the requirements that they want to be reviewed.
In that case, limit your feedback to only those requirements.
You may still use the full context for evaluation.

## Evaluate

### Formatting

- Requirements should follow the template under `design/requirements/TEMPLATE.md.mustache`.

### Consistency

- Statements that contradict each other, within a file or across files.
- Tags not documented in `design/requirements/<project>/TAGS.md`

### Duplication

- The same requirement stated in more than one place, especially where the copies have started to drift apart.
- The same concept under different names, or one name used for different concepts.
- Topics whose scopes overlap enough to make it unclear where a new requirement belongs.

### Clarity

- Statements that cannot be checked: vague qualifiers ("fast", "robust", "where possible") without a criterion, or "should" where the obligation is unclear.
- Undefined terms, acronyms and references to external documents without links.
- Implementation details mixed in with requirements, unless they are deliberately mandated.

### Organisation

- Empty or placeholder files, files that are too large or mix topics, and content in the wrong place, such as a roadmap inside a requirements file.
- File and folder names that don't match their content.

## Report

Write the report to `.agents/reports/requirement-lint/<yyyy>-<mm>-<dd>-<title>.md.
Make sure not to overwrite existing reports, use a different title instead.

Order suggestions by impact, putting contradictions and missing index entries first and cosmetic issues last.
For each one give:

- the location, as `path:line`;
- the problem, in one sentence;
- the proposed change, as before-and-after text, or as a move, split, merge or rename with the resulting index entry.

Keep observations separate from opinions about structure.
When several reasonable organisations exist, recommend one and explain the trade-off briefly.
Don't list every alternative.
