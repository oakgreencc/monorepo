---
title: oakgreen CLI
description: Commands, services, doctor checks and setup steps of the oakgreen umbrella CLI.
sidebar:
  order: 1
---

`oakgreen` checks a machine and repository, creates what is missing, runs the stack's services, and runs any of the stack's tools. Package: `oakgreen` on npm. Node ≥ 22.13. No third-party dependencies; GitHub access goes through [`graft api`](/reference/graft/cli/).

## Commands

| Command | Behaviour |
| --- | --- |
| `oakgreen <tool> [args...]` | Runs `graft`, `canker`, `deadwood`, `cambium`, `mycelium` or `canopy`. Stdio inherited, the tool's exit code returned. |
| `oakgreen doctor [--json] [--repo o/n] [--config <file>]` | The [doctor checks](#doctor-checks): `✓`/`✗` with a fix per failing line. Exit 1 if a required check fails. `--json` prints `{ ok, checks }`. |
| `oakgreen setup [--dry-run] [--repo o/n] [--config <file>]` | Idempotent bootstrap ([setup steps](#setup-steps)). `--dry-run` prints the plan and writes nothing. |
| `oakgreen services [--json] [service...]` | Each service's launchd agent: installed, loaded, running, pid. |
| `oakgreen start [service...]` | Installs the agent if missing, enables it, starts it. Default: every service. |
| `oakgreen stop [service...]` | Disables and unloads each, in reverse order. Stays stopped across logins until `start`. |
| `oakgreen restart [service...]` | A new process for each, on the same agent definition. Default: every installed service. |
| `oakgreen reload [service...]` | Re-reads each agent's plist (environment, program), then starts it. |
| `oakgreen update [--check]` | Installs the latest oakgreen and its tools, restarts running services, then runs `oakgreen doctor`. `--check` only reports. |

`--config` is cambium's config file. Default: `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`.

### Tool resolution

A tool runs from its installed package's `bin`, resolved from oakgreen's own `node_modules`, with the current Node. If the package is not installed, the bare name is looked up on `PATH`. A tool found in neither exits 127 with the install command.

## Services

launchd user agents, macOS only. Handled in this order:

| Service | Agent label | Runs | Agent written by |
| --- | --- | --- | --- |
| `otelcol` | `com.oakgreencc.otelcol` | Local OpenTelemetry collector | Copied by hand from cambium's `otel/` |
| `cambium` | `com.oakgreencc.cambium` | The scheduler daemon | `cambium install` |
| `mycelium` | `com.oakgreencc.mycelium` | `mycelium run` | `mycelium install` |
| `canopy` | `com.oakgreencc.canopy` | Status page, `http://127.0.0.1:4317/` | `canopy install` |

| Command | launchd behaviour |
| --- | --- |
| `start` | Leaves a running service alone. Writes a missing agent through its tool; with no names, a service whose tool refuses (no cambium config, no mycelium source) is skipped with the reason. Then `launchctl enable` and `bootstrap`, or `kickstart` when loaded but idle. |
| `stop` | `launchctl disable`, then `bootout`, waiting for the process to exit. |
| `restart` | `launchctl kill TERM`, then waits for KeepAlive to start a new pid. An installed agent that is not loaded is loaded. cambium finishes its current tick first; its workers keep running and are re-adopted. |
| `reload` | `launchctl bootout`, waits until launchd has released the old process, then `bootstrap` (retried a few times). |

- With no names, every service is handled and an uninstalled one is skipped. A named service that is not installed fails.
- Each command waits up to 3 minutes per process. Exit 1 if any did not come up.
- `start` installs canopy with its default flags.

## Update

- Updates only a global npm install (`<prefix>/lib/node_modules/oakgreen`), into the same prefix. A source checkout or `npm link` is refused with a hint.
- npm: the one next to the running Node, else `npm` on `PATH`. Version: the registry's `latest` dist-tag.
- A tool also installed on its own (`<prefix>/lib/node_modules/@oakgreencc/<tool>`) is upgraded to the version the latest oakgreen depends on, when older. A newer one is left alone. This copy is the one on `PATH` and in the cambium agent.
- `oakgreen update` runs one `npm install --global --prefix <prefix>` with `oakgreen@<latest>` (if newer) and each such `@oakgreencc/<tool>@<version>`, then restarts each running service (macOS). A stopped service stays stopped. Exit 1 if the install or a restart fails.
- When oakgreen is current but a standalone tool is behind, only the tool is installed. `--check` lists both.
- Before installing, each exact version the install needs (oakgreen and the tool versions it pins) is looked up on the registry. If one is not served yet, which happens for a few minutes after a release, it looks again after 10, 20, 30, 60, 60 and 60 seconds. Still missing after that: exit 1, nothing installed.
- npm runs with `--prefer-online`. An npm `ETARGET` or `E404` is retried on the same schedule. Other npm errors are not retried.
- Every run except `--check` ends with `oakgreen doctor` from the installed oakgreen, so an update shows the new version's checks. It also runs when oakgreen is up to date. It does not run when the install failed or did not start. A failing doctor check does not change the exit code.
- Every run lists versions: oakgreen (also the proxy service), then graft, canker, deadwood, cambium, mycelium and canopy, each from its standalone copy if there is one, else the one bundled with oakgreen. After an install these are the new versions. otelcol is not listed.

## Doctor checks

| Check | Passes when | Required |
| --- | --- | --- |
| `node` | `process.versions.node` satisfies oakgreen's `engines.node` | yes |
| `graft doctor` | `graft doctor` exits 0 (its last line is shown) | yes |
| `claude on PATH` | a `claude` executable is on `PATH` | yes |
| `cambium config` | the config file exists and parses | yes |
| `cambium status` | `cambium status --json --config <file>` exits 0 and reports a heartbeat. Not run without a config. | yes |
| `cambium heartbeat` | the heartbeat's `tick.finishedAt` is within 3 × `daemon.tickSeconds` | yes |
| `queue labels <repo>` | every [queue label](/reference/cambium/labels-and-state/) exists on the repository | yes |
| `mycelium <source>` | per enabled source: every variable it needs, plus `MYCELIUM_REPO` | yes |
| `canker config` | `canker.json` or a `"canker"` key in `package.json` at the git root | no |
| `deadwood config` | `deadwood.json` or a `"deadwood"` key in `package.json` at the git root | no |
| `label guide` | `docs/agents/triage-labels.md` at the git root names `q:intake` | no |

Repositories checked: `--repo`, else every `repos[].slug` in the cambium config, else `$MYCELIUM_REPO`.

Heartbeat file: `paths.heartbeat`, else `<paths.home>/state.json`, else `~/.cambium/state.json`.

Queue labels checked: `q:intake q:task q:human q:promote running why:budget why:reject why:approve why:triage why:rescue ask:decide ask:verify ask:chore ask:approve ask:session wait:deferred wait:blocked red-base rescue`.

## Setup steps

`oakgreen setup` runs these in order. A second run creates nothing.

1. **cambium config skeleton**, if the file is absent: one repo (`--repo`, else `$MYCELIUM_REPO`, else the `origin` remote, else `OWNER/NAME`), its path the current git root. An existing file is never touched.
2. **Queue labels**: each missing one, on each configured repository, through `graft api POST /repos/<repo>/labels`.
3. **Label guide**, when run from a clone of a configured repository: writes `docs/agents/triage-labels.md` if absent, and adds a `### Triage labels` pointer under `## Agent skills` in `CLAUDE.md` (else `AGENTS.md`), once. An existing guide is never rewritten; one that does not name `q:intake` is reported.
4. **Human steps**, printed: create and install the GitHub Apps (`graft setup app`), fill in `graft.app`, `graft.botLogin` and `worker.graftApp`, start the services, optionally write `~/.mycelium/env`.
