# Components: configure, run, check

Each section: what to ask, what to run (every command that changes the machine needs the user's yes first), and the check that proves it works. The packages' READMEs are the source of truth: `oakgreen`, `graft`, `cambium`, `mycelium`, `canopy`, `canker`, `deadwood` in https://github.com/oakgreencc/monorepo/tree/main/packages.

## Contents

- [The oakgreen CLI](#the-oakgreen-cli)
- [graft](#graft)
- [cambium](#cambium)
- [tracing](#tracing)
- [mycelium](#mycelium)
- [canopy](#canopy)
- [canker](#canker)
- [deadwood](#deadwood)
- [Doctor checks per component](#doctor-checks-per-component)

## The oakgreen CLI

`npm install -g oakgreen` installs `oakgreen` and, as its dependencies, every tool. `oakgreen <tool> [args]` runs a tool even when only oakgreen is on `PATH` (`oakgreen graft doctor`, `oakgreen cambium status`). The launchd agents point at the installed paths, so install globally rather than through `npx`.

Check: `oakgreen --version` prints a version.

## graft

Ask: the repository (`owner/name`, default from `git remote get-url origin`), whether to reuse an App this machine already holds.

Run: a human step (browser, private key), see [human-steps.md](human-steps.md#github-app-and-repository). `graft setup` from inside the repository does the App (if the owner has none) and the repository bootstrap in one go.

Check: `graft doctor` exits 0. Its lines `App credentials (<slug>)` and `App installed on <owner/name>` name the App slug that cambium's config needs.

## cambium

Ask: the local clone path, task cap, `engine` (`legacy` or `graph`), `merge` (`none`, or let cambium merge green PRs), which App cambium and its workers act as.

Run:

1. `oakgreen setup --dry-run --repo <o/n>`, show the output, then with a yes the same without `--dry-run`. It writes the `cambium` section of `~/.oakgreen/forest.json` only if there is none (other sections kept), creates an empty `~/.oakgreen/env` (600) for secrets, sets `repos[0].path` to the git root of the current directory (so run it from the clone), and creates the queue labels (`q:intake q:task q:human q:promote running why:budget why:reject why:approve why:triage why:rescue wait:deferred wait:blocked red-base rescue`) on GitHub. Run from the clone, it also writes the label guide `docs/agents/triage-labels.md` and a pointer to it in `CLAUDE.md`/`AGENTS.md`, so agents file issues with `q:intake` instead of another vocabulary's labels. Those two files are repo changes for the user to commit. Its "Remaining human steps" list is what the rest of this wizard covers.
2. Edit the `cambium` section of `forest.json` (show the diff, ask). If it already existed (`= "cambium" section in … exists; left as is`), add this repo to `repos[]` yourself: `{ "slug": "<o/n>", "path": "<clone>", "baseBranch": "main" }`, plus `"requiredCheck": null` when the repo has no `ci` check yet (otherwise its base never reads green). The App settings below are global, not per repo: on a config that already serves another owner, leave them as they are and rely on graft's owner → App mapping (`graft setup app` records it; `graft doctor` from the clone shows which App it picked). Otherwise: `graft.app` = the App slug, `graft.botLogin` = `<slug>[bot]`, `worker.graftApp` = the workers' App slug (often the same), plus `phases.task.cap`, `engine`, `merge` if the user chose non-defaults. Keep it valid JSON; the daemon re-reads it every tick, but `engine`, `paths` and `graft` need a restart (`oakgreen restart cambium`).
3. The target repo's worktrees go under `.claude/worktrees` by default: check that path is in the repo's `.gitignore`, and offer to add it (a repo change for the user to commit).
4. `oakgreen start cambium` (with a yes): runs `cambium install` to write `~/Library/LaunchAgents/com.oakgreencc.cambium.plist` on first run, then loads it. `cambium install --dry-run --config <file>` shows the agent first. With a `forest.json` outside the default path (`$OAKGREEN_FOREST_CONFIG_PATH`), write the agent yourself first (`cambium install --config <file>`, with a yes), then `oakgreen start cambium`. Recommend the default path unless the user has a reason.

Check: `oakgreen services cambium` shows it running with a pid; after one tick (`tickSeconds`, default 30 s) `cambium status --config <file>` exits 0 and the doctor's `cambium status` and `cambium heartbeat` pass.

## tracing

Ask: local files only (default), plus Jaeger, or AWS (X-Ray and Managed Prometheus).

The collector config and its launchd agent ship in cambium's package, in `otel/`. Find it:

```sh
OTEL_DIR="$(npm root -g)/oakgreen/node_modules/@oakgreencc/cambium/otel"
[ -d "$OTEL_DIR" ] || OTEL_DIR="$(npm root -g)/@oakgreencc/cambium/otel"
ls "$OTEL_DIR"   # otelcol.yaml, otelcol-aws.yaml, com.oakgreencc.otelcol.plist
```

Run (each with a yes):

1. `otelcol-contrib` on `PATH`: `command -v otelcol-contrib`. If missing, it is a download from the [otelcol releases](https://github.com/open-telemetry/opentelemetry-collector-releases/releases) (`otelcol-contrib_<v>_darwin_arm64.tar.gz`, or `darwin_amd64` on Intel) into `/opt/homebrew/bin` or `/usr/local/bin`, as in cambium's README "Local collector". The agent's `PATH` is `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, so it must be in one of those.
2. `mkdir -p ~/.oakgreen/cambium/otel ~/.oakgreen/cambium/logs && cp "$OTEL_DIR/otelcol.yaml" ~/.oakgreen/cambium/otel/otelcol.yaml` (or `otelcol-aws.yaml` saved under the same name, for AWS), then `otelcol-contrib validate --config ~/.oakgreen/cambium/otel/otelcol.yaml`.
3. `cp "$OTEL_DIR/com.oakgreencc.otelcol.plist" ~/Library/LaunchAgents/`, then `oakgreen start otelcol`.
4. cambium's `OTEL_*` env, in its agent (cambium reads tracing settings from its environment only):

   ```sh
   P=~/Library/LaunchAgents/com.oakgreencc.cambium.plist
   plutil -replace EnvironmentVariables.OTEL_EXPORTER_OTLP_ENDPOINT -string http://127.0.0.1:4318 "$P"
   plutil -replace EnvironmentVariables.OTEL_EXPORTER_OTLP_TIMEOUT -string 2000 "$P"
   oakgreen reload cambium
   ```

   Needs cambium's agent to exist (step 5 of the run order writes it; do this right after). Tell the user that `cambium install` rewrites the plist without these, so after any re-install they repeat this step. Spans are only produced for graph runs (`engine: "graph"`); say so if the user kept `legacy`.
5. mycelium (if chosen): add `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` to `~/.oakgreen/env`, then `oakgreen restart mycelium`.
6. Jaeger (optional): `docker run -d --name jaeger -p 16686:16686 -p 14317:4317 jaegertracing/jaeger:latest`; UI on `http://127.0.0.1:16686`. AWS: the collector's process needs AWS credentials from the default chain, and X-Ray Transaction Search enabled; that is a human step.

Check:

- `oakgreen services otelcol` shows it running.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{"resourceSpans":[]}' http://127.0.0.1:4318/v1/traces` prints `200`.
- `plutil -extract EnvironmentVariables.OTEL_EXPORTER_OTLP_ENDPOINT raw ~/Library/LaunchAgents/com.oakgreencc.cambium.plist` prints the endpoint.
- With `engine: "graph"`, `~/.oakgreen/cambium/otel/traces.jsonl` grows after cambium's next graph run.

The doctor does not check tracing; these checks are its proof.

## mycelium

Ask: the sources (discord; asc for App Store and TestFlight; play for Google Play reviews and vitals), the repo that receives intake issues (`repo` in its `forest.json` section), whether to answer reporters (`discordNotify`).

Run: the human writes the secrets, see [human-steps.md](human-steps.md#mycelium-credentials). Then (each with a yes, the first is read-only):

1. `mycelium poll <source> --dry-run` per source: plans issues, writes nothing.
2. `oakgreen start mycelium`: `mycelium install` writes the agent (it refuses with no source or no `repo`), then it is loaded.

The repo needs the queue labels, which `oakgreen setup --repo <o/n>` creates; run it for mycelium's `repo` if cambium was not chosen.

Check: the doctor's `mycelium <source>` lines pass; `oakgreen services mycelium` shows it running; `~/.oakgreen/mycelium/logs/mycelium.log` has a `mycelium up:` line naming the repo and sources.

## canopy

Ask: the port (default 4317).

Run (with a yes): `oakgreen start canopy` (writes the agent with defaults on first run). For another port: `canopy install --port <n>` then `oakgreen reload canopy`; `canopy install --dry-run` shows the agent first.

Check: `oakgreen services canopy` running; `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/` prints `200`; in `curl -fsS http://127.0.0.1:<port>/api/state`, `heartbeat.status` is `"ok"` once cambium has ticked.

Then the name (with a yes): `oakgreen start proxy` serves `http://canopy.localhost/` on port 80, loopback only; nothing to configure. If port 80 is taken it says so: `oakgreen proxy install --port <n>` then `oakgreen reload proxy`. Check: `oakgreen services proxy` running; `curl -fsS -o /dev/null -w '%{http_code}\n' http://canopy.localhost/` prints `200`.

## canker

Ask: which repo, config as `canker.json` or a `"canker"` key in `package.json`, `maxCrap` (default 30). canker reads a coverage report (Istanbul `coverage-final.json` or lcov), so the repo's tests must write one. With Node's own runner: `mkdir -p coverage && node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info` (the reporter does not create the directory), and `"coverage": ["coverage/lcov.info"]` in canker's config.

Run (repo changes, with a yes): `npm install -D @oakgreencc/canker` (or the repo's package manager: `pnpm add -D`), write `canker.json` with `{ "maxCrap": 30 }` (or the user's values), then run the tests with coverage and `npx canker`. A repo with existing offenders can freeze them: `canker --update` only lowers a committed baseline, see canker's README "Ratchet".

Without a devDependency, `oakgreen canker` runs the copy that came with oakgreen. Check: the doctor's `canker config` passes when run from the repo; `npx canker` exits 0, or 1 with a table the user accepts as the starting point.

## deadwood

Ask: which repo, config as `deadwood.json` or a `"deadwood"` key in `package.json`, extra markdown files to allow (defaults: `**/README.md`, `AGENTS.md`, `CLAUDE.md`), `comments.maxDensity` (default 0.15).

Run (repo changes, with a yes): `npm install -D @oakgreencc/deadwood`, write `deadwood.json` (`{}` is the defaults), then `npx deadwood`. Existing offenders can go into `deadwood.baseline.json`, which may only shrink; see deadwood's README.

Check: the doctor's `deadwood config` passes when run from the repo; `npx deadwood` exits 0, or 1 with offenders the user accepts.

## Doctor checks per component

`oakgreen doctor --json` prints `{ ok, checks: [{ name, ok, required, detail, fix }] }`. Its `ok` covers the whole stack, so judge the checks of the chosen components:

| Component | Doctor checks that must pass                                                                                   | Other proof                                    |
| --------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| always    | `node`                                                                                                         |                                                |
| graft     | `graft doctor`                                                                                                 |                                                |
| cambium   | `claude on PATH`, `cambium config`, `cambium status`, `cambium heartbeat`, `queue labels <o/n>`, `label guide` | `oakgreen services cambium` running            |
| tracing   | (none)                                                                                                         | the checks under [tracing](#tracing)           |
| mycelium  | every `mycelium <source>`, `queue labels <o/n>` for `MYCELIUM_REPO`                                            | `oakgreen services mycelium` running           |
| canopy    | (none)                                                                                                         | `oakgreen services canopy` running, `curl` 200 |
| canker    | `canker config` (optional in the doctor; required here when chosen)                                            | `npx canker`                                   |
| deadwood  | `deadwood config` (optional in the doctor; required here when chosen)                                          | `npx deadwood`                                 |

Run the doctor from inside the repository so the canker and deadwood checks look at it, and pass `--config` when the cambium config is not at the default path.
