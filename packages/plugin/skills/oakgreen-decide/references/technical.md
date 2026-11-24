# Technical lens

For decisions about how something is built: architecture, interfaces, dependencies, data model, tooling.

## Sources for `orient`

Look in this order, and cite each fact:

1. The issue, its comments and any linked issues or PRs.
2. Existing ADRs (`docs/adr/`, `docs/decisions/`, `adr/`) and architecture notes: a decision already made constrains this one.
3. The code the options touch: modules, interfaces, call sites, tests (`file:line`). Count what each option changes.
4. Dependencies: `package.json` and lockfiles, versions, licences, upstream docs for the APIs involved (URL).
5. CI, deployment and runtime constraints: workflows, configs, platform limits.

Good facts for a technical decision: what exists today, what each option changes and breaks, its cost in files and modules, the risks (data migration, performance, lock-in), and what it makes easy or hard later.

## Draft template (ADR-shaped)

Render the draft for the person like this at `confirm`; the JSON fields are in brackets.

```markdown
## Decision: <one-sentence choice>                      [choice]

**Context.** The forces at play: what exists, what constrains it. (from facts, with sources)

**Considered options**

- <option>: cost, consequence (one line each, from the re-costed options)

**Decision.** What we will do and why it beats the others, in two or three sentences.

**In scope** [inScope]

- …

**Out of scope** [outOfScope]

- …

**Consequences**

- Easier: …
- Harder: …

**Acceptance checks** [acceptance]

- [ ] A test / command / interface shows …

**Follow-ups** [followUps]

- <title>: <one line> (an ADR to record this decision, when the repo keeps ADRs)
```

Acceptance checks are things a task worker can prove: a test that passes, an interface that exists, a command whose output changes. When the repo keeps ADRs, add a follow-up to record this one there.
