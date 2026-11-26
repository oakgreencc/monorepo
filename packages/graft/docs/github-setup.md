# GitHub setup — what a human configures, and why

graft's local layer (hooks, gates, maintainer mode) is a set of tripwires. An
agent with a shell can step over any of them. What it can't step over is
GitHub: an App permission it doesn't hold, or a ruleset it can't edit. This
page covers those. `graft setup` does both for you: the App, and the base
branch's ruleset — which it writes as _you_, through `gh`, because the App
deliberately can't touch rulesets. `graft doctor` checks all of it.

## 1. The App

`graft setup app` creates it through GitHub's manifest flow. You review the
pre-filled form and click Create. Then you install the App.

| Permission            | Level | Why                                                            |
| --------------------- | ----- | -------------------------------------------------------------- |
| Contents              | write | the Git Database API: blobs, trees, commits, refs              |
| Pull requests         | write | open, update and merge PRs                                     |
| Issues                | write | comments, labels, closing references                           |
| Metadata              | read  | mandatory. It also lets `doctor` read branch rules             |
| Actions               | read  | `graft jobs`: run and job logs                                 |
| Checks, Statuses      | read  | the required check, for the stop-the-line rule                 |
| Organization projects | write | only with `--projects` on an org (Projects v2 is GraphQL-only) |

The App deliberately doesn't get these:

- **Workflows.** Without it, GitHub rejects any App write that touches
  `.github/workflows/**`. CI judges the agent's work, and an agent that could
  edit CI could make itself green. Workflow changes are described by the agent
  and applied by a human.
- **Administration.** Rulesets, branch protection, required checks and
  code-owner enforcement all sit behind it. The App mustn't be able to loosen
  the rules it's held to.
- **Secrets.** Nothing an agent does needs them.

No webhooks. The App is private.

**Install scope.** Install it only on the repositories agents should work in
("Only select repositories"). An installation token covers the whole
installation, so the installation is the blast radius.

Commits the App creates through the API are signed by GitHub and show as
**Verified** as `<app>[bot]`. No key material touches git, and nothing is
attributed to you.

## 2. The base-branch ruleset

`graft setup project` handles this. It reads the rules in force on the base
(`baseBranch` in `.graft.json`) as the App, and if any of the ones below are
missing, it creates a ruleset named `graft: <base>` — or adds the missing rules
to the one that exists — through `gh api`, as you. It only ever adds: other
rulesets, and the rest of `graft: <base>`, are left as you set them.
Repository admins may bypass it, through pull requests only (so a solo
maintainer can merge their own PR); the App never can.

Without `gh` logged in as a repository admin, setup writes the ruleset to
`~/.oakgreen/graft/rulesets/<owner>-<repo>-<base>.json` instead: import it at
Settings → Rules → New ruleset → **Import a ruleset**
(`https://github.com/<owner>/<repo>/settings/rules`).

What it contains, and why:

- **Require a pull request before merging.**
- **Require review from Code Owners.** This is what makes CODEOWNERS binding.
  Without it, CODEOWNERS is documentation. graft reads CODEOWNERS as its
  manifest of protected paths and refuses to edit or publish them without your
  grant. This rule is what stops a PR that touches them from merging without
  you, whatever happened locally. Once you approve such a PR, `graft pr merge`
  (and `--auto`) lets the agent land it, so you act once: approve. It checks
  GitHub's own records — the base's CODEOWNERS, an individual `@login` owner's
  approval for every protected path, no owner requesting changes — and follows
  this ruleset on stale approvals: with `dismiss_stale_reviews_on_push: false`
  (graft's default) an approval on an earlier commit still counts; otherwise it
  must be on the current head. Team-owned paths and `protected.extra` still
  need you to merge.
- **Require status checks to pass** — once there is CI:
  `graft setup project --required-check <job>`. If agents merge their own PRs,
  CI is the acceptance gate, and `requiredCheck` in `.graft.json` lets
  `graft pr merge` stop the line when the base is red.
- **Require signed commits.** graft's commits are Verified. This keeps out
  anything pushed with the local git binary, which is unsigned and attributed
  to whoever `user.name` says.
- **Block force pushes and deletion.**

Don't add the App to the bypass list.

## 3. Optional: a branch-name ruleset for the App

`graft setup project` asks whether to confine the App to its own namespace
(`--app-branches <prefix | none>` answers without asking). Yes creates a second
ruleset, `graft: app branches`, through `gh`, as you: it targets every branch
except `agent/**` and restricts creations. Repository admins, maintainers and
writers bypass it, so people can still create any branch; the App never can.
With it in place, a mangled command can't create a branch named `--api`.

It restricts creations only. Writing to the base directly is already blocked
by the base ruleset's pull-request rule, and restricting updates outside
`agent/**` would also block the App's own `graft pr merge`.

Other bots that create branches — Dependabot, Renovate — are held to it too.
When setup finds their config it says so and defaults to no; to have both, add
them to the ruleset's bypass list.

## 4. Optional: auto-merge

`graft setup project` asks whether to turn on **Allow auto-merge**, which
`graft pr merge --auto` needs (`--auto-merge` / `--no-auto-merge` answer
without asking). It defaults to yes when agents may merge into some base. The
merge still waits for the ruleset's required checks and reviews. A PR that is
already mergeable — GitHub will not arm auto-merge on one — is merged at once.

Without `gh` logged in as a repository admin, both steps print where to do them
by hand instead.

## 5. Check

```
graft doctor
```

`✗` lines are broken. `!` lines work, but give you less protection than it
looks like.
