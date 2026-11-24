---

name: oakgreen-decide
description: Walks a person in a Claude Code session to a decision on a cambium Human Queue issue (labels ask:decide + ask:session) by driving cambium's decide graph with `cambium decide show` and `cambium decide advance`. You gather facts with sources, ask rounds of at most 5 numbered questions each with a recommendation, draft the decision (brief-shaped for the product lens, ADR-shaped for the technical lens), check it is complete, and commit it back to the issue. Use when the user runs /oakgreen:decide, pastes a cambium session brief that says to start with /oakgreen:decide, or asks to work through, decide or answer an ask:decide issue with the code. Not for building the change, since a decision session never writes code.
---

# oakgreen decide

You help a person decide one GitHub issue cambium has put in the Human Queue. cambium owns the process: its **decide graph** says which step comes next, checks every output you give it against that step's schema, and keeps the checkpoint (a `cambium:decide` comment on the issue). You do the steps and talk to the person. You never skip a step, never invent the person's answer, and never write code in this session.

The issue is `<owner/repo#n>`, from the command argument or the session brief. If neither names one, ask for it.

## Rules for the whole session

- **Decisions are the person's; facts are yours.** Never ask the person something the code, the docs or the issue can answer: look it up and cite it (`file:line`, URL, API route). Never decide for them: every choice goes to them as a question with your recommendation.
- **At most 5 numbered questions per round**, each with a recommendation worded so that "yes" accepts it ("Yes: build parts 2 and 3 now, because …"). Number them so the person can answer `2: later`. "yes" alone accepts every recommendation in the round. Fewer, sharper questions beat five weak ones; ask the question whose answer unlocks the most first.
- **Completeness before commit.** Before you show the draft for confirmation, check it against [Completeness](#completeness). cambium refuses a `yes` on an incomplete decision anyway; do not make the person hit that.
- **The checkpoint is the truth.** Read state only from `cambium decide show`; never from memory of earlier in the chat. A session can stop anywhere and resume later, here or elsewhere.
- **Stop means stop.** If the person says stop, abandon, or not now, pass their words as the reply; cambium ends the decision without an answer.

## The loop

```sh
cambium decide show <owner/repo#n>          # where it stands, what the next step needs
cambium decide show <owner/repo#n> --json   # the whole state, when you need detail
```

`show` prints the current node, the context the person needs (the round, the draft), and a `Next:` line naming the JSON the step takes. Do that step, write its JSON to a file (or pipe it), then:

```sh
cambium decide advance <owner/repo#n> --output /tmp/decide-<n>.json   # or --output - with the JSON on stdin
```

If it prints `refused`, read every listed issue, fix the output and advance again; the checkpoint is unchanged. If it succeeds it prints the next node; repeat until it says `Outcome:`. Use `--as <github-login>` on every advance when `$GITHUB_USER` is not the person's login: cambium credits them with the decision.

A first `show` on an issue whose ask has no lens fails: ask the person whether this is a product or a technical decision (see the lenses below) and pass `--lens product|technical`.

## The steps

Each step's JSON holds only the fields that step sets; an unknown field is refused. The lens files say where to look and what the draft looks like: [product](references/product.md), [technical](references/technical.md). Read the one for this decision's lens before `orient`.

| Node            | You do                                                                                                                                                                                                                                                      | Output                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `open`          | Read the issue, its comments and the session brief. Restate the question in one sentence; fix the options if the ask's are vague. Set `visual` when the options differ in what someone sees (layout, screens, wording on screen).                           | `{"question"?, "options"?: [{label, detail, cost}], "lens"?, "visual"?, "notes"?}`    |
| `orient`        | Research the facts the decision depends on, from the lens's sources, each with a source. Re-cost each option (S/M/L and why). List the open sub-decisions as the `frontier`, most unlocking first.                                                          | `{"facts": [{claim, source}], "frontier": ["scope", …], "options"?, "notes"?}`        |
| `mock`          | Only for a visual ask. One self-contained static HTML file per option (inline CSS, no scripts, no network), close enough to the real UI to judge. cambium saves them next to the checkpoint and links them from the round.                                  | `{"mocks": [{option, html}]}`                                                         |
| `ask-round`     | Turn the frontier into at most 5 questions, each with `rec`. Use `choices` when the answers are a short fixed list. Ids are short slugs that match the frontier.                                                                                            | `{"questions": [{id, title, text, choices?, rec}]}`                                   |
| `await-answers` | Show the round exactly as `advance` printed it (numbers, recommendations, mock links), then wait for the person. Pass their words verbatim.                                                                                                                 | `{"reply": "<their words>"}`                                                          |
| `apply-answers` | Map the reply onto the questions ("yes" = every rec). Move answered ids to `decided`; keep anything still open, or newly raised, in `frontier`. If the answer turns on a fact you can look up, list it in `needFacts` (back to `orient`) instead of asking. | `{"answers": [{id, text}], "decided": [ids], "frontier": [...], "needFacts"?: [...]}` |
| `draft`         | Write the decision with the lens's template (below). `acceptance` holds checks a task worker can verify; `followUps` are issues worth filing, each with a body that stands alone.                                                                           | `{"draft": {choice, inScope, outOfScope, acceptance, followUps: [{title, body}]}}`    |
| `confirm`       | Run the completeness check, then show the draft rendered with the lens template and ask: commit, change, or abandon? Read their reply as `yes`, `edit` (put what to change in `notes`) or `abandon`.                                                        | `{"reply": "<their words>", "confirm": "yes"\|"edit"\|"abandon", "notes"?}`           |

`commit` and `abandon` run without you. On commit cambium files the follow-ups to `q:intake` and posts the decision on the issue as the person's answer; triage picks the issue up again. Tell the person the answer's link and stop. Do not start building.

A `paused` node (the decision sat idle) takes the output of the wait it left: the person's reply, as for `await-answers` or `confirm`.

## Completeness

Before `confirm`, check, and fix by another round or a redraft:

- Every question asked has an answer, or was decided another way.
- Nothing is left on the frontier, and no fact is still needed.
- The choice is one sentence a task worker could act on; something is in scope, and what was considered and left out is out of scope.
- Every acceptance check is observable (a command, a screen, a behaviour), not a restatement of the choice.
- Each follow-up has a title and a body that makes sense without this session.
- A visual decision has its mocks, and the draft names the mock it chose.
- Every fact the draft relies on has a source.

## Lenses

- **product**: what users get (scope, behaviour, wording, defaults, priority). The draft is brief-shaped and checks its terms against the glossary. [references/product.md](references/product.md)
- **technical**: how it is built (architecture, interfaces, dependencies, data model, tooling). The draft is ADR-shaped. [references/technical.md](references/technical.md)

The lens changes where you look and how the draft reads. It never changes the steps.
