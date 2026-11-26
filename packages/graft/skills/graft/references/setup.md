# Setting up graft

Setup creates a GitHub App in a browser and stores its private key on this machine, so the **human** runs it. Give them these commands; in Claude Code the `!` prefix runs a command as them.

## 1. Install the CLI (once per machine)

```
npm install -g @oakgreencc/graft      # or: git clone … && npm link
graft --version
```

The skill ships separately: `npx skills add oakgreencc/monorepo -g` (or the Claude Code plugin from the same repo).

`graft` must be on `PATH`: the Claude hooks and the git credential helper call it by name. Node ≥ 22, no other dependencies.

## 2. Create the App (once per GitHub owner)

Run it from inside the repository — the owner comes from its `origin` remote, and whether that is a personal account or an organization is asked of GitHub. Don't guess `--owner`/`--org`; pass one only to create the App for a _different_ account than origin's.

```
! graft setup                      # App if this owner has none, then step 3 — one command
! graft setup app                  # just the App; --manual to register an existing App
```

A `!` command has no terminal, so setup runs as if `--yes` were given: every question takes its default (e.g. the App name `<owner>-agents`; `--name` to choose another) and file writes are confirmed. A question with no default — the owner, outside a repository — makes it exit naming the flag that answers it.

Opens GitHub's "create App from manifest" page with the permissions pre-filled (contents, pull requests, issues: write; actions, checks, statuses: read; no workflows, no administration). After creation it saves the key to `~/.oakgreen/graft/apps/<slug>/`, then opens the install page — install it on the repositories agents should work in.

## 3. Bootstrap the repository (once per repo)

```
! graft setup project              # already done if step 2 ran bare `graft setup`
```

Checks each piece and changes only what is missing, so it is safe to re-run:

- **In the repo:** writes `.graft.json` (base branch, validation command, hooks path, merge policy), seeds or extends CODEOWNERS so the policy files are owned, and merges into `.claude/settings.json`: the git env block (HTTPS rewrite + `graft credential` helper + local signing off), the graft hooks, and permissions. Review the diff it shows, then commit those files the normal human way. **Restart any Claude Code session already open in the repo**: the env and hooks load at session start, so an open session's raw git still authenticates as the human.
- **On GitHub:** makes the base branch require a PR with **review from Code Owners** (what makes CODEOWNERS a boundary rather than a tripwire), signed commits, and no force pushes or deletion — creating or extending the `graft: <base>` ruleset through `gh`, as the human, since the App cannot. Admins may bypass through PRs. Without `gh` as an admin it leaves a JSON file to import at Settings → Rules → Import a ruleset. Details: `docs/github-setup.md` in the graft repo.

## 4. Check

```
graft doctor
```

Every ✗ names its fix. `!` lines are warnings worth reading (e.g. a base branch without required signatures).

Run inside a Claude Code session, doctor also says what a raw `git fetch` in **that session** would authenticate as — over SSH, through a helper other than `graft credential`, or as the App — and whether the session's git env matches `.claude/settings.json`. The `graft hook session-check` SessionStart hook says the same at session start when it is wrong.
