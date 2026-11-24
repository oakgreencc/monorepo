# oakgreen plugin

An agent plugin with two skills. `oakgreen-setup` is a guided wizard that sets up the oakgreen stack on a machine. It asks which components to set up (graft and its GitHub App, cambium, the OTel collector and cambium's `OTEL_*` env, mycelium, canopy, canker, deadwood) and how to configure each one. It asks before every step that changes the machine and does the work through the [`oakgreen`](../oakgreen) CLI (`doctor`, `setup --dry-run`, `start`, `services`). Steps only a human can do, such as creating the GitHub App or writing secrets, come as instructions, each with a check. The run ends when `oakgreen doctor` passes for the chosen components.

`oakgreen-decide` (with the `/oakgreen:decide <owner/repo#n>` command) works a cambium Human Queue decision, an issue labelled `ask:decide` + `ask:session`, with a person in Claude Code. See [Decide](#decide).

## Install

**Claude Code**, from this repo's marketplace:

```sh
claude plugin marketplace add oakgreencc/monorepo
claude plugin install oakgreen@oakgreencc
```

Then ask for it ("set up oakgreen for my repo") or run `/oakgreen:oakgreen-setup`; for a decision, run `/oakgreen:decide owner/repo#42`, or start from the session brief cambium writes for the issue.

**Kiro**: Powers panel → Add Custom Power → Import power from a repository URL → `https://github.com/oakgreencc/monorepo/tree/main/packages/plugin`. A local checkout works too: Import power from a folder → `packages/plugin`. The skill alone also installs as a Kiro skill: Agent Steering & Skills → Import a skill → `…/packages/plugin/skills/oakgreen-setup`.

## Decide

`/oakgreen:decide <owner/repo#n>` drives cambium's [decide graph](../cambium#the-decide-graph) from the session. cambium owns the process: `cambium decide show` prints where the decision stands and what the next step needs; `cambium decide advance <ref> --output <file|->` checks the session's output for that step against its schema, follows the edge, writes the `cambium:decide` checkpoint comment and prints the next step. A refused output lists every problem and leaves the checkpoint as it was. The session does the steps and talks to the person:

1. **open, orient**: restate the question, then gather the facts it depends on, each with a source, from the sources the lens names; list the open sub-decisions.
2. **mock** (visual asks only): one static HTML mock per option. cambium saves them next to the checkpoint copy in `~/.cambium/decide/<owner>__<repo>/issue-<n>/mocks/` and links them from the round.
3. **ask-round, await-answers, apply-answers**: at most 5 numbered questions, each with a recommendation worded so "yes" accepts; the person's reply is mapped back, and a question a fact can answer goes back to orient instead. Rounds repeat until nothing is open.
4. **draft, confirm**: the decision in the lens's template, a completeness check, then yes, edit or abandon. cambium refuses a "yes" on an incomplete decision.
5. **commit**: cambium files the follow-ups as `q:intake` and posts the decision on the issue as the person's answer (`cambium:answer`), which sends it back to triage.

Its rules come from a partner product flow: decisions are the person's, facts are the agent's; every question carries a recommendation; nothing is committed before the completeness check. The two lenses change where the session looks and the draft's shape, never the steps: **product** (what users get) writes a brief-shaped decision and checks its terms against the glossary; **technical** (how it is built) writes an ADR-shaped one. A session can stop anywhere; the next `/oakgreen:decide` resumes from the checkpoint.

## Layout

| Path                                 | For                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude-plugin/plugin.json`         | Claude Code plugin manifest                                                                                                                |
| `plugin.json`                        | Kiro power manifest ([format](https://kiro.dev/docs/powers/create/), `agent-plugins.org` 1.0.0 schema)                                     |
| `skills/oakgreen-setup/SKILL.md`     | The skill (Agent Skills format, read by both tools)                                                                                        |
| `skills/oakgreen-setup/references/`  | Per-component commands and checks, the human-only steps, troubleshooting                                                                   |
| `skills/oakgreen-setup/evals/`       | Wizard-flow cases in the `claude plugin eval` layout (`<case>/prompt.md`, `case.yaml`, `graders/`), and `trigger-eval.json` for triggering |
| `commands/decide.md`                 | The `/oakgreen:decide <owner/repo#n>` command (Claude Code)                                                                                |
| `skills/oakgreen-decide/SKILL.md`    | The decide skill: the loop over `cambium decide`, per-step instructions, the completeness check                                            |
| `skills/oakgreen-decide/references/` | The product (brief-shaped) and technical (ADR-shaped) lenses: sources and draft templates                                                  |

## Evals

The evals were made with Anthropic's skill-creator. Run the wizard cases with `claude plugin eval skills/oakgreen-setup --allow-tools Write,Edit,Bash`. These are real, billed model runs, and they run on this machine, so read the cases first. The trigger set runs through skill-creator's `scripts/run_eval.py --eval-set skills/oakgreen-setup/evals/trigger-eval.json --skill-path skills/oakgreen-setup`.

## Tests

```sh
npm test
```

The tests check that both manifests agree and have the fields each tool requires, that the marketplace lists the plugin, and that the skill's frontmatter, links and eval cases are well formed. They also check that every `oakgreen <command>` the setup skill names exists in the CLI, that the decide skill names only `cambium decide` verbs cambium has and covers every step, and that the command hands its argument to the skill.

## License

AGPL-3.0-only
