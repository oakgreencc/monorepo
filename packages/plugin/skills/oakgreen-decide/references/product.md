# Product lens

For decisions about what users get: scope, behaviour, wording, defaults, priority.

## Sources for `orient`

Look in this order, and cite each fact:

1. The issue, its comments and any linked issues or PRs.
2. Product and design docs in the repo: briefs, PRDs, specs, `docs/`, `CONTEXT.md`, design files or screenshots it links.
3. The glossary (`GLOSSARY.md`, `CONTEXT.md` or the docs' terminology page). Note every term the options use and whether the glossary defines it.
4. The current behaviour in the code: the screens, copy strings, defaults and feature flags the options would change (`file:line`).
5. Analytics, support or feedback the repo or issue links, when the choice turns on how people use it.

Good facts for a product decision: what users see today, what each option changes for them, who is affected, what it costs to build (from the code), what it rules out later.

## Glossary checks

Before `draft`:

- Every domain term in the choice, scope and acceptance checks is the glossary's word, with the glossary's meaning.
- A term the glossary lacks, or one the decision gives a new meaning, becomes a follow-up ("Add <term> to the glossary") unless the person says otherwise.
- Two words for one thing is a question for the next round, not something you settle.

## Draft template (brief-shaped)

Render the draft for the person like this at `confirm`; the JSON fields are in brackets.

```markdown
## Decision: <one-sentence choice>                      [choice]

**Problem.** Who has it and what happens today, in two sentences. (from facts)

**In scope** [inScope]

- …

**Out of scope** [outOfScope]

- … (and why, in a few words)

**Acceptance checks** [acceptance]

- [ ] A user can … / The screen shows … / The default is …

**Follow-ups** [followUps]

- <title>: <one line>

**Mock chosen:** <option> (visual asks only)
**Facts relied on:** <claim> (<source>), …
```

Acceptance checks describe what a user sees or can do, so a task worker and a reviewer can both verify them.
