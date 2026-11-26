---
title: GitHub App and rulesets
description: The permissions graft's GitHub App holds and withholds, and the rulesets graft setup creates.
sidebar:
  order: 4
---

`graft setup` creates both: the App through GitHub's manifest flow, and the rulesets through `gh`, as the human, because the App cannot touch rulesets. `graft doctor` checks both.

## App permissions

| Permission | Level | Used for |
| --- | --- | --- |
| Contents | write | Git Database API: blobs, trees, commits, refs |
| Pull requests | write | Opening, updating and merging PRs |
| Issues | write | Comments, labels, closing references |
| Metadata | read | Mandatory; lets `graft doctor` read branch rules |
| Actions | read | `graft jobs`: run and job logs |
| Checks, Statuses | read | The required check |
| Organisation projects | write | Only with `--projects` on an organisation |

Withheld:

| Permission | Effect of withholding |
| --- | --- |
| Workflows | GitHub rejects any App write touching `.github/workflows/**`. |
| Administration | The App cannot change rulesets, branch protection, required checks or code-owner enforcement. |
| Secrets | — |

No webhooks. The App is private. Installation scope: only the repositories agents work in. Commits the App creates through the API show as **Verified** as `<app>[bot]`.

Key storage: `~/.oakgreen/graft/apps/<slug>/`.

## Base-branch ruleset

Name: `graft: <base>`. Created, or extended with missing rules, by `graft setup project`. It only adds rules; other rulesets are left alone.

| Rule | Effect |
| --- | --- |
| Require a pull request before merging | No direct writes to the base. |
| Require review from Code Owners | CODEOWNERS paths cannot merge without the owner. |
| Require status checks to pass | Added with `--required-check <job>`. |
| Require signed commits | Keeps out unsigned commits from the local git binary. |
| Block force pushes and deletion | — |

Bypass: repository admins, through pull requests only. The App is never on the bypass list.

Without `gh` logged in as a repository admin, the ruleset is written to `~/.oakgreen/graft/rulesets/<owner>-<repo>-<base>.json` for import at Settings → Rules → New ruleset → Import a ruleset.

## App-branches ruleset (optional)

Name: `graft: app branches`. Created by `graft setup project` on request (`--app-branches <prefix | none>`).

- Targets every branch except `agent/**`.
- Restricts branch creation only.
- Bypass: repository admins, maintainers and writers. The App never bypasses it.
- Other branch-creating bots (Dependabot, Renovate) are held to it unless added to the bypass list.

## Auto-merge (optional)

`graft setup project` turns on the repository's **Allow auto-merge** setting on request (`--auto-merge` / `--no-auto-merge`). Default: on, when agents may merge into some base. `graft pr merge --auto` needs it. Merges still wait for the ruleset's checks and reviews.

## CODEOWNERS

graft reads CODEOWNERS with GitHub's semantics as the list of protected paths. Locations checked follow GitHub's: `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`. `graft setup project` seeds or extends it so the policy files are owned.
