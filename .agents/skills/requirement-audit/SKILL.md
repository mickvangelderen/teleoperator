---
name: design-audit
description: Compare the implementation against the hand-written requirements in the design folder and report major discrepancies. Use when asked whether the code meets the requirements, to audit conformance, or before a milestone or release.
---

# Check the implementation against the requirements

Produce a report of major discrepancies between the hand-written requirements
and what the repository actually implements. The report is for the user to
decide whether the code or the requirements should change.

## Process

1. Read the requirements index and every file it links to, then the rest of
   `design/`. Note files under `design/requirements/` that the index does not
   link, and index links that are dead.
2. Split the requirements into atomic, checkable statements. Keep the source
   path and line for each one.
3. For each statement, look for evidence in code, tests, build scripts and
   documentation. When subagents are available, use them to search in
   parallel; give each one the statements it should check and ask for paths
   and line numbers, not summaries.
4. Classify each statement:
   - **Contradicted**: the implementation does something the requirement rules
     out.
   - **Missing**: nothing implements it, and nothing marks it as planned.
   - **Partial**: implemented for some cases, platforms or streams only.
   - **Unverifiable**: checking it needs hardware, a human or information the
     repository does not contain. Say what would verify it.
   - **Satisfied**: only count these; do not list them.
5. Also look the other way: significant behaviour, dependencies or interfaces
   that a requirement forbids or that cut against the stated priorities.
6. Discard minor issues such as style, naming and small gaps that don't
   change behaviour. When unsure whether something is major, ask: would the
   user need to make a decision about it?

## Report

Write the report to `.agents/reports/design-audit/<yyyy>-<mm>-<dd>-<title>.md. Order findings from most to least
severe. For each one give:

- the requirement, quoted, with `path:line`;
- the observed behaviour, with `path:line` evidence;
- the classification and how confident you are, separating what you observed
  from what you infer;
- the decision the user has to make (change the implementation, or change the
  requirement), without choosing for them.

Finish with counts per classification, the statements you could not check and
why, and any requirements too ambiguous to check. Point to
`design-lint` for those.
