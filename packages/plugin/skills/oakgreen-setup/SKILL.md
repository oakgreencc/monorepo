---

name: oakgreen-setup
description: Guided setup wizard for the oakgreen stack (oakgreencc). It asks which parts the user wants (graft and its GitHub App, the cambium scheduler, the OTel collector and tracing, mycelium intake, the canopy status page, canker, deadwood), asks how to configure each, then installs and checks them through the oakgreen CLI until `oakgreen doctor` passes. Use when someone wants to install, set up, onboard, bootstrap or repair oakgreen, cambium, graft, mycelium, canopy, canker or deadwood on their machine or a repository, or to get agent workers running on their repo, even if they do not say "setup". Not for running or debugging a stack that already works.
---

# oakgreen setup

A wizard: you find out what the user wants, show what you will change, change it only with their yes, and prove each part works. The **oakgreen CLI** does the work (`oakgreen doctor`, `oakgreen setup`, `oakgreen start`, `oakgreen services`, `oakgreen <tool>`). Do not write your own install scripts or plists. The CLI is idempotent and tested, so running it twice is safe and a hand-rolled script would drift from it.

The stack runs as launchd user agents, so the services (cambium, mycelium, canopy, otelcol) are **macOS only**. graft, canker and deadwood work anywhere Node ≥ 22.13 runs.

## Rules for the whole run

- **Read freely, change only with a yes.** Read-only commands need no permission: `--version`, `oakgreen doctor`, `oakgreen services`, `oakgreen setup --dry-run`, `graft doctor`, `cambium install --dry-run`, `canopy install --dry-run`, `plutil -p`, `curl` to localhost. Anything that writes a file, installs a package, creates a GitHub label or loads a launchd agent changes the machine: say exactly what it will do (the command and the files it touches), then ask, then run it. One yes covers one step, not the rest of the run.
- **Ask with a question tool when there is one** (Claude Code: `AskUserQuestion`, multi-select for the component list). Otherwise ask in chat with numbered options. Offer the default you would pick, so a user who does not know can just accept it.
- **Secrets never pass through the chat.** Private keys, tokens and passwords are written by the human, into files you name. You check that the file exists, has mode `0600` and has the keys, without printing values (`grep -c`, `cut -d= -f1`). If the user pastes a secret anyway, do not copy it into a command or file yourself: it now sits in the chat log, so suggest rotating it, and have them write the new one into the file.
- **Human-only steps get a check.** For each one: say why only they can do it, give the exact command or page, wait for them to say done, then run its check. If the check fails, show its output and help, but do not move on. The steps and their checks are in [references/human-steps.md](references/human-steps.md).
- **Prefer `--dry-run` first.** `oakgreen setup`, `cambium install` and `canopy install` all take it. Show its output, then ask to run it for real.

## 1. Look before asking

Run these, read-only, and summarize what is already there in a few lines:

```sh
node --version; uname -s
oakgreen --version || npx --yes oakgreen --version
graft --version; claude --version
oakgreen doctor --json        # add --repo o/n if the user named one
oakgreen services --json      # macOS only
```

If `oakgreen` is missing, propose `npm install -g oakgreen` (it brings every tool with it) and ask. Node older than 22.13 is a human fix (nvm, Homebrew, the installer): say so and stop until `node --version` is right.

Existing state matters: a user re-running this to fix one thing should not be walked through the whole stack again. Mark components that already pass as done and offer only the rest.

## 2. Ask which components

Offer these, with one line each (more in [references/components.md](references/components.md)):

| Component    | What it gives them                                                      | Needs                      |
| ------------ | ----------------------------------------------------------------------- | -------------------------- |
| **graft**    | Agents write to GitHub as a GitHub App: Verified commits, scoped access | always (the others use it) |
| **cambium**  | The scheduler: runs `claude -p` workers on `q:task` issues, watches PRs | graft, Claude Code, macOS  |
| **tracing**  | Local OTel collector + cambium's `OTEL_*` env; traces in canopy         | cambium, `otelcol-contrib` |
| **mycelium** | Intake: Discord, App Store, Google Play feedback → `q:intake` issues    | graft, macOS, source creds |
| **canopy**   | Local status page at `http://canopy.localhost/` (or `127.0.0.1:4317`)   | cambium, macOS             |
| **canker**   | CI gate: fails complex untested functions (CRAP score)                  | a repo with test coverage  |
| **deadwood** | CI gate: markdown allowlist, comment-density ceiling                    | a repo                     |

graft is required for everything except canker and deadwood; pick it automatically when anything else is chosen and say why. If they choose canopy or tracing without cambium, explain that both read cambium's output and ask whether to add cambium.

## 3. Ask how to configure each

Ask only what the chosen components need; take defaults from what step 1 found (the `origin` remote, an existing `forest.json`).

- **Repository** (graft, cambium, mycelium, canker, deadwood): `owner/name`, and the local clone path. cambium makes worktrees from that clone.
- **Where config and secrets go**: every component's config is one section of `~/.oakgreen/forest.json` (or `$OAKGREEN_FOREST_CONFIG_PATH`): `cambium`, `mycelium`, `canopy`, `graft`, `proxy`. Secrets (tokens, keys, passwords) go only in `~/.oakgreen/env`, mode 600, written by the human. Never write a per-service file (`~/.cambium/config.json`, `~/.mycelium/env`): nothing reads them. `oakgreen setup` adds only a missing `cambium` section; edits to an existing section are yours, with a yes. A machine that still has those old files needs `oakgreen config migrate` first (`--dry-run`, then for real, with the services stopped).
- **GitHub Apps** (graft, cambium): reuse an App this machine already has (`graft doctor` names it) or create one. cambium can act as one App and its workers as another (`graft.app`, `worker.graftApp`); one App for both is fine to start.
- **cambium options**: task cap (default 2), `engine` (`legacy` default; `graph` for triage and tracing of graph runs), who merges (`merge`: `none` default).
- **tracing**: local files only (default), plus Jaeger (needs Docker), or AWS X-Ray (`otelcol-aws.yaml`).
- **mycelium**: which sources (discord, asc, play) and the repo issues go to (`repo` in its `forest.json` section).
- **canopy**: port (default 4317), set in its `forest.json` section.
- **canker / deadwood**: install as devDependencies in the repo, and config as a file (`canker.json`, `deadwood.json`) or a `package.json` key.

Then **show the plan**: an ordered list of every step, marked _you_ (agent, with a yes) or _human_, with the files and services each touches. Ask for a go on the plan before step 4. The go does not replace the per-step yes.

## 4. Do it, in this order

The order follows the dependencies: credentials before anything calls GitHub, the config before the daemon, the collector before cambium sends spans to it. Details and commands per component are in [references/components.md](references/components.md).

1. **Install the CLI** if missing: `npm install -g oakgreen`.
2. **graft** _(human)_: create and install the GitHub App, bootstrap the repo: `! graft setup` from the repo. Check: `graft doctor` passes.
3. **cambium config and labels**: `oakgreen setup --dry-run --repo <o/n>`, show it, then run it without `--dry-run`. It writes the `cambium` section of `forest.json` (only if absent) and an empty `~/.oakgreen/env` (600), creates the queue labels, and, run from the clone, writes the label guide `docs/agents/triage-labels.md` plus a pointer in `CLAUDE.md`/`AGENTS.md`. Agents read the guide to file issues with `q:intake` and leave the queue labels to cambium. Without it they fall back to labels nothing reads (`ready-for-agent`, `hitl:*`). The guide and pointer are repo changes: include them in the step 8 commit. An existing `cambium` section is left as is, so a new repo on a machine that already runs cambium needs its own `repos[]` entry, added by you (show the diff, ask). Then set the App in the `cambium` section: `graft.app`, `graft.botLogin` (`<app-slug>[bot]`) and `worker.graftApp` apply to **every** repo in it, so set them for a config that serves only this owner; when it already serves other owners, leave them and let graft's per-owner App mapping (the `graft` section, written by `graft setup app`) pick the App. Add the options from step 3 the same way.
4. **tracing**: collector config and agent, then `oakgreen start otelcol`; then the `OTEL_*` env in cambium's agent.
5. **cambium**: `oakgreen start cambium` (writes the agent on first run, then loads it).
6. **mycelium** _(human writes the secrets)_: you write the non-secret settings into its `forest.json` section (with a yes); the human writes the credentials into `~/.oakgreen/env`. Then `mycelium poll <source> --dry-run`, then `oakgreen start mycelium`.
7. **canopy**: a non-default port goes in its `forest.json` section (`canopy install` takes no flags); `oakgreen start canopy`, then `oakgreen start proxy` so it answers at `http://canopy.localhost/` (port 80 taken: `oakgreen proxy install --port <n>` first).
8. **canker / deadwood**: devDependency and config file in the repo. These, and the label guide from step 3, are repo changes: the user commits them their usual way (in a graft repo, through `graft publish`).

After each step run its check from [references/components.md](references/components.md) and say in one line whether it passed.

## 5. Finish with the doctor

From inside the repository (canker and deadwood are checked at the git root of the current directory):

```sh
oakgreen doctor --json --repo <o/n> --config <file>
oakgreen services
```

`oakgreen doctor` checks the whole stack, so judge it **for the chosen components**: the table in [references/components.md](references/components.md#doctor-checks-per-component) maps each component to its checks. Every check of a chosen component must pass; a failing check of a component the user did not choose is reported as "not set up (not chosen)", not as a failure. `cambium heartbeat` needs one tick after `oakgreen start cambium`: wait for `tickSeconds` (30 s by default) and run the doctor again before calling it failed.

End with a short report: each chosen component, ✓ or ✗ with the check that proves it, the plain-text doctor output, what the user still has to do (e.g. commit `.graft.json` and `.claude/settings.json`, restart open Claude Code sessions in the repo), and where to look next (`oakgreen services`, `cambium status`, canopy's URL).

## When something fails

Show the failing command's output and the `fix:` line the doctor printed; it names the fix. Common ones are in [references/troubleshooting.md](references/troubleshooting.md). Do not work around a failure by hand-editing a launchd plist that a tool writes (`cambium install`, `mycelium install`, `canopy install`), except to add the `OTEL_*` variables as described for tracing.
