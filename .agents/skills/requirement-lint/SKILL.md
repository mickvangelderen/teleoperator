---
name: design-lint
description: Review the design folder itself for consistency, duplication, clarity and organisation, and suggest edits for the user to make. Use when asked to review, tidy or restructure the design documents or requirements index.
---

# Review the design folder

Review the documents in `design/` as a body of information, independent of the implementation.
Suggest concrete edits for the user to make.

## What to check

**Consistency**
- Statements that contradict each other, within a file or across files.
- The same concept under different names, or one name used for different concepts.
- Banners, headings, list style and wording conventions applied unevenly across files.

**Duplication**
- The same requirement stated in more than one place, especially where the
  copies have started to drift apart.
- Topics whose scopes overlap enough to make it unclear where a new
  requirement belongs.

**Clarity**
- Statements that cannot be checked: vague qualifiers ("fast", "robust",
  "where possible") without a criterion, or "should" where the obligation is
  unclear.
- Undefined terms, acronyms and references to external documents without
  links.
- Implementation details mixed in with requirements, unless they are
  deliberately mandated.

**Organisation**
- Every file under `design/requirements/` is in the index, and every index
  link resolves.
- Each index entry has a one-line scope that tells a reader what belongs in
  the file.
- Empty or placeholder files, files that are too large or mix topics, and
  content in the wrong place, such as a roadmap inside a requirements file.
- File and folder names that don't match their content.

## Report

Write the report to `.agents/reports/design-extract/<yyyy>-<mm>-<dd>-<title>.md.
Order suggestions by impact, putting contradictions and missing index entries first and cosmetic
issues last. For each one give:

- the location, as `path:line`;
- the problem, in one sentence;
- the proposed change, as before-and-after text, or as a move, split, merge
  or rename with the resulting index entry.

Keep observations separate from opinions about structure. When several
reasonable organisations exist, recommend one and explain the trade-off
briefly. Don't list every alternative.
