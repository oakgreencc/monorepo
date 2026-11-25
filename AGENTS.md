# Working in this repo

1. **Task:** the GitHub issue you were given. Its acceptance checks are the definition of done.
2. **Verify:** `pnpm verify` (lint + tests, Nx-cached). Green means committable; the pre-commit hook runs the same command.
3. **Push:** `graft publish agent/<topic> "<conventional commit message>" --paths <a,b> --pr "<title>"`. Never `git commit`, `git push`, `git fetch` or `git pull`.
4. **Done:** `graft ci wait agent/<topic>`, then the PR merges through the queue.

Work in a worktree under `.claude/worktrees/<topic>`. When finished, remove it (ExitWorktree `remove`, no `discard_changes`). `graft pr merge` run in the worktree finishes it (`graft worktree done`). If the PR merged another way (queue, auto-merge), run `graft worktree done agent/<topic>` before the remove. If `done` exits 1 or the remove is refused, the worktree holds work GitHub lacks: publish it, don't discard it.

A change to a user-facing fact (a flag, default, label, behaviour) updates the matching page in `docs/` in the same PR. Those pages are for humans: follow [docs/AGENTS.md](docs/AGENTS.md).

## Agent skills

### Triage labels

File issues with `q:intake` only; cambium triages and moves them. See `docs/agents/triage-labels.md`.
