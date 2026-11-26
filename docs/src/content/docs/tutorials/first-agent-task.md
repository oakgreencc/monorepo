---
title: Your first agent task
description: Label an issue, watch cambium run a Claude Code worker on it, and see the pull request it opens.
sidebar:
  order: 2
---

In this tutorial we will hand a GitHub issue to an agent. cambium will start a Claude Code worker in its own worktree, the worker will publish a pull request through graft, and once you merge it cambium will close the issue. Then we will start cambium as a service and watch a second issue go through on its own.

It takes about thirty minutes, most of it waiting for the worker.

## Before you start

- Finish [Your first Verified commit](/tutorials/first-verified-commit/). We use the same `you/sandbox` clone and App.
- macOS (the services are launchd agents) with Node 22.13 or newer.
- [Claude Code](https://claude.com/claude-code) installed and signed in: `claude --version` prints a version.
- No `cambium` section in `~/.oakgreen/forest.json` yet.

Work from the sandbox clone throughout:

```sh
cd sandbox
```

## 1. Install the stack

```sh
npm install -g oakgreen
oakgreen --version
```

This installs `oakgreen` with cambium, canopy and the other tools.

## 2. Set up the queue

```sh
oakgreen setup --repo you/sandbox
```

You will see it write the `cambium` section of `~/.oakgreen/forest.json`, create the queue labels (`q:intake`, `q:task`, `q:human` and the rest) on the sandbox, and write a label guide for agents into the clone. It ends with a list of remaining steps; we do them next.

## 3. Point cambium at your App

Open `~/.oakgreen/forest.json`. Fill in the App's slug (the name `graft doctor` shows in `App credentials (…)`, here `you-agents`), turn off the base-health check because the sandbox has no CI, and allow one worker at a time:

```json
{
  "repos": [{ "slug": "you/sandbox", "path": "/Users/you/sandbox", "baseBranch": "main", "requiredCheck": null }],
  "phases": { "task": { "cap": 1, "wallClockMinutes": 60, "maxTurns": 200, "maxAttempts": 3 } },
  "graft": { "command": "graft", "app": "you-agents", "botLogin": "you-agents[bot]" },
  "worker": { "command": "claude", "args": [], "graftApp": "you-agents" }
}
```

Keep the `path` setup wrote for you.

Workers get their worktrees under `.claude/worktrees` in the clone. Keep them out of git locally:

```sh
echo ".claude/worktrees/" >> .git/info/exclude
```

## 4. Tell workers how to check their work

Workers read the repository's `AGENTS.md`. Give the sandbox one, published the way you learned in the first tutorial:

```sh
cat > AGENTS.md <<'EOF'
# Working in this repo

Verify: `test -f haiku.txt`. There is no `pnpm verify` here.
EOF
graft publish agent/agents-md "docs: add AGENTS.md" --paths AGENTS.md --pr "Add AGENTS.md"
```

Merge that pull request on GitHub before going on: workers start from `origin/main`.

## 5. File a task

```sh
cat > issue.md <<'EOF'
Add `haiku.txt` with a three-line haiku about oak trees.

Acceptance: `haiku.txt` exists and has three lines.
EOF
graft issue create --title "Add a haiku" --body-file issue.md --labels q:task
```

graft prints the new issue as JSON. Note its `number`; we will say `7`.

## 6. Run the worker

```sh
cambium run task --issue 7
```

cambium claims the issue (it gains the `running` label), creates a worktree at `.claude/worktrees/7-add-a-haiku`, and starts `claude -p` in it. The worker runs in the foreground, so this takes a few minutes.

When it finishes, cambium records the outcome. Open the issue on GitHub:

- It has lost `q:task` and `running`.
- cambium has left one comment describing the issue's state.
- A pull request from `agent/7-add-a-haiku` closes it, with a Verified commit from the App.

## 7. Merge, and let cambium close out

Merge the pull request on GitHub. Then run one tick of the scheduler:

```sh
cambium start --once
```

cambium sees the merged pull request, closes issue 7 and deletes its branch.

## 8. Run it as a service

```sh
oakgreen start cambium canopy
oakgreen services
```

Both show as running with a pid. Open [http://127.0.0.1:4317/](http://127.0.0.1:4317/): this is canopy. The header shows the mode and the last tick.

## 9. Do it again, hands off

File a second task:

```sh
cat > issue.md <<'EOF'
Add a second haiku to `haiku.txt`, about acorns, after the first one.

Acceptance: `haiku.txt` has two haiku.
EOF
graft issue create --title "Add an acorn haiku" --body-file issue.md --labels q:task
```

Watch canopy's **Queue** tab. Within a tick (30 seconds) the issue moves from the `q:task` lane to **Running**, then its pull request appears. Merge it, and within another tick the issue closes.

## What you did

You turned a labelled issue into a merged pull request without touching the code. cambium kept every bit of state on GitHub, in labels and one comment, and the worker wrote only through graft.

When you are finished, stop the services:

```sh
oakgreen stop cambium canopy
```

## Next

- [Add a real repository to cambium](/how-to/add-a-repository-to-cambium/).
- [Let cambium merge green pull requests](/how-to/let-cambium-merge-green-prs/).
- [How the pieces fit together](/explanation/architecture/).
