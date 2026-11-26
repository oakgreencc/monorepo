# graft

Formerly **agit**. A machine or repo set up under that name keeps working: `.agit.json`, the `"agit"` key in `package.json`, `AGIT_*` variables, and the `agit` command are all still read. (Its old machine directory, `~/.config/agit`, moves with `oakgreen config migrate`.)

Let a coding agent work a GitHub project **as a GitHub App**, with the local `git` binary kept read-only toward GitHub.

- **Verified commits, not pushes.** `graft publish` builds the tree locally with git, ships only the missing blobs, and has GitHub _create_ the commit through the Git Database API. GitHub signs it: it lands **Verified** as the App — never unsigned, never authored as whichever human `user.name` resolved to. Merges too (`graft merge`).
- **Your git hooks still run.** A publish never runs `git commit` or `git push`, so graft runs `pre-commit`, `prepare-commit-msg`, `commit-msg` and `pre-push` itself, at the equivalent moments, on the exact tree that ships.
- **CODEOWNERS is the manifest.** Whatever CODEOWNERS assigns an owner is _protected_: the agent's editor hooks refuse the edit, `graft publish` refuses the path, and `graft pr merge` refuses the PR until a code owner has approved it on GitHub — all before the work, not at review. With "require Code Owner review" on the base branch, GitHub enforces the same list as a hard boundary.
- **Maintainer mode.** A human lifts part of the protective layer with a scoped (`protected`, `no-verify`, `merge`), session-bound, expiring grant — `! graft maintainer grant "why" --scope protected`. graft stays in the loop; only that gate moves, for that session.
- **Gates that come from incidents.** Scope (`--paths` or `--all`, never an implied sweep), payload (no `*.log`, no path growing by >512 KiB), displacement (a stale worktree silently reverting work), validated base (a green run about a different base), version floor.

Zero dependencies, Node ≥ 22.

## Quick start

```sh
npm install -g @oakgreencc/graft      # the CLI; must be on PATH
npx skills add oakgreencc/monorepo -g # the agent skill (or: /plugin marketplace add oakgreencc/monorepo)
graft setup app                       # in a repo: creates the GitHub App for origin's owner, stores its key
cd your-repo && graft setup project   # .graft.json, CODEOWNERS, .claude/settings.json, base-branch ruleset
graft doctor
```

Then, as the agent:

```sh
graft validate
graft publish agent/fix-login "fix: login redirect" --paths src/auth --pr "Fix login redirect" --closes 42
```

Beyond the write path, the agent's everyday GitHub work has verbs too — JSON on stdout, bodies from files:

```sh
graft ci wait <sha|branch> [--check ci]            # exit 0 green, 1 red, 2 unknowable
graft issue read 42                                # includes the body etag `issue edit` needs
graft issue create --title "…" --body-file b.md [--labels bug]
graft issue comment 42 --body-file c.md            # `--body-file -` reads stdin
graft issue close 42 --body-file c.md [--reason not_planned]
graft issue edit 42 --body-file b.md --etag <etag>
graft issue assign 42 --login alice
graft issue label 42 --add bug --remove triage
```

`graft help` lists every verb.

Full walkthrough: [skills/graft/references/setup.md](skills/graft/references/setup.md). GitHub-side configuration: [docs/github-setup.md](docs/github-setup.md).

## Pieces

|                                           |                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/graft.mjs`                           | the CLI; `graft help`                                                                                                                          |
| `skills/graft/`                           | the agent skill (also installable as a Claude Code plugin from this repo)                                                                      |
| `src/publish/`                            | the primitive: tree build, blob shipping, signed commit, fast-forward ref, safe advance                                                        |
| `src/gates/`                              | scope, payload, displacement, validated base, version                                                                                          |
| `src/git-hooks.mjs`                       | runs the repository's git hooks during a publish                                                                                               |
| `src/codeowners.mjs`, `src/protected.mjs` | CODEOWNERS parsed with GitHub's semantics → the protection policy                                                                              |
| `src/maintainer.mjs`                      | scoped, session-bound grants in `.git/graft/`                                                                                                  |
| `src/github/`                             | the App client; issue reads/writes (`graft issue`); check verdicts (`graft ci wait`)                                                           |
| `src/hooks/`                              | Claude Code hooks: credential guard, protected-path guard, PR-write guard, worktree sync                                                       |
| `src/status.mjs`, `src/worktree.mjs`      | `graft status`, and `graft worktree done`: rewind a merged worktree so ExitWorktree passes (`graft pr merge` runs it in the PR's own worktree) |
| `src/setup/`                              | `graft setup` (App manifest flow, project bootstrap) and `graft doctor`                                                                        |

Design notes: [docs/design.md](docs/design.md). The one invariant everything rests on: [docs/verified-commits.md](docs/verified-commits.md).

Releases are cut automatically from `main`: [docs/releasing.md](docs/releasing.md).

## Configuration

`.graft.json` at the repo root (tracked, and itself protected). Every field optional:

```json
{
  "baseBranch": "develop",
  "mergeableBases": ["develop"],
  "requiredCheck": "ci",
  "validate": { "command": "npm run ci" },
  "hooks": { "path": ".githooks", "required": ["pre-push"] },
  "protected": { "owners": ["@you"], "extra": [], "impossible": [".github/workflows/**"] },
  "payload": { "ceilingBytes": 524288, "neverPublish": ["*.log"] },
  "minVersion": "0.1.0"
}
```

Or put the same object under an `"graft"` key in the root `package.json`; `graft setup project` asks which (`--config-in`). One place only: both present is refused.

graft protects that key, not the whole file: an edit, publish or merge that changes `"graft"` needs a grant, while a dependency bump stays ordinary. GitHub cannot enforce a key, so `graft doctor` warns unless CODEOWNERS also owns `/package.json`; own it, or use `.graft.json`, when you want GitHub's review as the hard boundary.

Defaults and the reasoning behind each: [src/config.mjs](src/config.mjs). Machine identity (which App acts for which owner) is the `graft` section of `~/.oakgreen/forest.json` (`$OAKGREEN_FOREST_CONFIG_PATH` names another file), never the repo; App keys live in `$GRAFT_HOME/apps/<slug>/` (default `~/.oakgreen/graft`), mode 0600. A machine still holding `~/.config/graft` with no `graft` section is refused, naming `oakgreen config migrate`.

REST reads go through an ETag cache in `~/.oakgreen/graft/cache/http/` ([src/github/http-cache.mjs](src/github/http-cache.mjs)): a repeated GET sends `If-None-Match`, and a 304 is served from the cache without spending rate limit. `GRAFT_HTTP_CACHE=0` turns it off. A GraphQL answer that is a `RATE_LIMIT` error is thrown as `graphql: rate limited until <reset>: …`, so a poller can wait out the reset.

## Tests

```sh
npm test
```

The publish primitive is tested against a fake GitHub backed by a bare repository, so the tree-sha equality check, merges, and the hook runner are exercised with real git.

## License

AGPL-3.0-only.
