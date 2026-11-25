# oakgreen

One command for the stack: `oakgreen doctor` checks a machine and repository, `oakgreen setup` creates what is missing, `oakgreen start`/`stop`/`restart`/`reload` run its services, and `oakgreen <tool>` runs any of the stack's tools.

Zero third-party dependencies, Node ≥ 22.13 (cambium needs `node:sqlite`). GitHub access goes through [`graft api`](../graft).

## Usage

```sh
npm install -g oakgreen
oakgreen setup --repo owner/name    # labels, label guide, cambium config skeleton, then the human steps
oakgreen doctor                     # one checklist, exit 1 if a required check fails
oakgreen graft status               # any tool, args passed through
oakgreen start                       # install (first time) and start every service that is configured
oakgreen services                    # are otelcol, cambium, mycelium, canopy and proxy running?
oakgreen restart                     # new processes, e.g. after npm updates
oakgreen stop mycelium               # stopped until the next start, across logins too
oakgreen update                      # latest oakgreen and its tools, then restart what runs
```

| Command                                                     | What                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `oakgreen <tool> [args...]`                                 | Run `graft`, `canker`, `deadwood`, `cambium`, `mycelium` or `canopy`; stdio inherited, its exit code returned. |
| `oakgreen doctor [--json] [--repo o/n] [--config <file>]`   | The checklist below, `✓`/`✗` with a fix per failing line; `--json` prints `{ ok, checks }`.                    |
| `oakgreen setup [--dry-run] [--repo o/n] [--config <file>]` | Idempotent bootstrap; `--dry-run` prints what it would do and writes nothing.                                  |
| `oakgreen services [--json] [service...]`                   | The stack's launchd agents: installed, loaded, running, pid. See [Services](#services).                        |
| `oakgreen start [service...]`                               | Install the agent if missing (its tool's `install`), enable it, start it. Default: every service.              |
| `oakgreen stop [service...]`                                | Disable and unload each, in reverse order; it stays stopped across logins until `start`.                       |
| `oakgreen restart [service...]`                             | A new process for each (all installed ones by default), on the same agent definition.                          |
| `oakgreen reload [service...]`                              | Re-read each agent's plist too (its env, its program), then start it.                                          |
| `oakgreen update [--check]`                                 | Install the latest oakgreen and its tools, restart running services, run doctor. See [Update](#update).        |
| `oakgreen proxy [--port n]`                                 | Serve `http://<name>.localhost/` for the stack's web UIs. See [Proxy](#proxy).                                 |
| `oakgreen proxy install [--port n] [--dry-run]`             | Write the proxy's launchd agent (`oakgreen start` does this the first time).                                   |

A tool runs from its installed package's `bin` (resolved from `oakgreen`'s own `node_modules`) with the current Node; if the package is not installed, the bare name is looked up on `PATH`. A tool found in neither exits 127 with the install command.

`--config` is cambium's config file; the default is `$CAMBIUM_CONFIG`, then `~/.cambium/config.json`.

## Services

The long-running parts of the stack are launchd user agents (macOS only for now), handled in this order:

| Service    | Agent                     | What                                                                                 |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `otelcol`  | `com.oakgreencc.otelcol`  | The local OpenTelemetry collector (cambium's `otel/`), whose trace file canopy reads |
| `cambium`  | `com.oakgreencc.cambium`  | The scheduler daemon (`cambium install` writes the agent)                            |
| `mycelium` | `com.oakgreencc.mycelium` | The intake connectors, `mycelium run` (`mycelium install` writes the agent)          |
| `canopy`   | `com.oakgreencc.canopy`   | The status page on `http://127.0.0.1:4317/` (`canopy install` writes the agent)      |
| `proxy`    | `com.oakgreencc.proxy`    | `http://<name>.localhost/` on :80, see [Proxy](#proxy) (`oakgreen proxy install`)    |

- **`start`** leaves a running service alone. A missing agent is written by its tool (`cambium install`, `mycelium install`, `canopy install`; otelcol has none, see cambium's [Tracing](../cambium/README.md#tracing)); with no names, one its tool refuses (no cambium config, no mycelium source) is skipped with the reason. Then `launchctl enable` and `bootstrap`, or `kickstart` when it is loaded but idle.
- **`stop`** is `launchctl disable` then `bootout`, waiting for the process to exit. Disabled, launchd will not start it at login; `start`, `restart` and `reload` all enable it again.
- **`restart`** sends SIGTERM (`launchctl kill TERM`) and waits for KeepAlive to bring up a new pid. cambium finishes its current tick first; its workers keep running and are re-adopted. Use it after `npm i -g` of a new version (or let `cambium update` do both, see cambium's [Self-update](../cambium/README.md#self-update)). An installed agent that is not loaded is loaded.
- **canopy** is served with its defaults when `oakgreen start` installs it. For other flags (a port, a repo list), write the agent yourself first, e.g. `canopy install --port 4400`, then `oakgreen reload canopy`; `canopy install --dry-run` prints it.
- **`reload`** is for a changed plist (an added `OTEL_*` variable, a new Node path): `launchctl bootout`, then it **waits until launchd has let go of the old process** before `launchctl bootstrap` (retried a few times). Bootstrapping while cambium is still finishing a tick is what fails with `Bootstrap failed: 5: Input/output error`.
- With no names, every service is handled and one that is not installed is skipped; a named one that is not installed fails. Each waits up to 3 minutes for its process; exit 1 if any did not come up.
- canopy is not a service here: it runs in the foreground (`canopy`, or `pnpm start` in the monorepo).

## Proxy

`oakgreen proxy` is a reverse proxy on port 80 that gives each web UI a name instead of a port:

| URL                        | Goes to           |
| -------------------------- | ----------------- |
| `http://canopy.localhost/` | `127.0.0.1:4317`  |
| `http://jaeger.localhost/` | `127.0.0.1:16686` |
| `http://localhost/`        | a list of routes  |

- **No DNS setup.** `*.localhost` is reserved for loopback (RFC 6761) and browsers resolve it themselves, so there is no `/etc/hosts` entry or sudo; browsers also treat it as a secure context. (`.local` is mDNS's, `.lan` is unreserved and answered by routers.) Safari may need a hosts entry.
- **More routes** go in `~/.oakgreen/proxy.json`, merged over the defaults; `null` removes one. Restart the proxy after editing (`oakgreen restart proxy`).

  ```json
  { "routes": { "grafana": 3000, "jaeger": null } }
  ```

- **Loopback only.** macOS lets an unprivileged process bind a port below 1024 only on the wildcard address, so it listens on `::` (IPv4 and IPv6) and destroys every connection that does not come from loopback before reading it. A request is answered only when its `Host` is `localhost` or `<name>.localhost`, so a page elsewhere cannot reach it through DNS rebinding.
- **Upstreams** see `Host: 127.0.0.1:<port>` (canopy refuses other Hosts) and `X-Forwarded-Host: <name>.localhost`. WebSocket and other `Upgrade` requests are passed through.
- A route whose service is down answers 502 naming the port; an unknown name, 404. Port 80 already taken: the proxy exits 1 saying so (`--port 8080` serves `http://canopy.localhost:8080/` instead; `oakgreen proxy install --port 8080` to keep it).
- Logs: `~/.oakgreen/logs/proxy.log`.

## Update

oakgreen depends on every tool, so updating it updates the stack. It updates itself only when it is a **global npm install** (`<prefix>/lib/node_modules/oakgreen`), into that same prefix, so `PATH` and the launchd agents' paths stay valid; a source checkout or `npm link` is refused with a hint. npm is the one next to the running Node, else `npm` on `PATH`; the version is the registry's `latest` dist-tag.

- **`oakgreen update --check`** only reports: up to date, or `a → b available`.
- **`oakgreen update`** runs `npm install --global --prefix <prefix> oakgreen@<latest>`, then (macOS) restarts each service that is running, as `oakgreen restart` does; a stopped one stays stopped. Exit 1 if the install or a restart fails.
- If the registry does not serve a version the install needs yet (a release can take a few minutes to reach it), `oakgreen update` waits and looks again for about four minutes, then gives up with nothing installed. npm runs with `--prefer-online`; an npm `ETARGET` is retried the same way.
- Every `oakgreen update` (not `--check`) ends with the installed oakgreen's `oakgreen doctor`, so you see config the new version wants changed. Its result does not change the exit code.
- Every run lists versions (`versions:`): oakgreen (also the proxy service), then graft, canker, deadwood, cambium, mycelium and canopy, each from its standalone global copy if there is one, else the copy bundled with oakgreen. After an install these are the new versions. otelcol is not an oakgreen package and is not listed.
- cambium's own `cambium update` / `update.auto` cover a separately installed `@oakgreencc/cambium`.

## Doctor

| Check                 | Passes when                                                                                                                                                  | Required |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `node`                | `process.versions.node` satisfies this package's `engines.node`                                                                                              | yes      |
| `graft doctor`        | `graft doctor` exits 0 (its last line is shown)                                                                                                              | yes      |
| `claude on PATH`      | a `claude` executable is on `PATH`                                                                                                                           | yes      |
| `cambium config`      | the config file exists and parses                                                                                                                            | yes      |
| `cambium status`      | `cambium status --json --config <file>` exits 0 and reports a heartbeat; not run without a config, since it would create its database                        | yes      |
| `cambium heartbeat`   | the heartbeat's `tick.finishedAt` is within 3 × `daemon.tickSeconds` (file: `paths.heartbeat`, else `<paths.home>/state.json`, else `~/.cambium/state.json`) | yes      |
| `queue labels <repo>` | `q:intake q:task q:human q:promote running why:budget why:reject why:approve why:triage why:rescue wait:deferred wait:blocked red-base rescue` all exist     | yes      |
| `mycelium <source>`   | per enabled source (any of its `MYCELIUM_*` vars set, in the environment or mycelium's env file): every var it needs, plus `MYCELIUM_REPO`                   | yes      |
| `canker config`       | `canker.json` or `package.json` `"canker"` at the git root of the current directory                                                                          | no       |
| `deadwood config`     | `deadwood.json` or `package.json` `"deadwood"` at the git root                                                                                               | no       |
| `label guide`         | `docs/agents/triage-labels.md` at the git root names `q:intake`                                                                                              | no       |

The repositories checked are `--repo`, else every `repos[].slug` in the cambium config, else `$MYCELIUM_REPO`.

## Setup

1. Writes a cambium config skeleton if the file is absent: one repo (`--repo`, else `$MYCELIUM_REPO`, else the `origin` remote; `OWNER/NAME` if none), its path the current git root. An existing file is never touched.
2. Creates each missing queue label on each configured repository with `graft api POST /repos/<repo>/labels`.
3. Run from a clone of a configured repository, writes the **label guide** `docs/agents/triage-labels.md` if absent: how agents file issues (`q:intake` only, blockers as GitHub blocked-by links, no `q:` on a tracking parent), the queue labels, the priority labels from the cambium config, and a mapping from the triage roles other skills use (`needs-triage`, `ready-for-agent`, …). That path is where mattpocock's `to-tickets`, `triage` and `wayfinder` skills look, so they use these labels instead of their defaults. It then adds a `### Triage labels` pointer under `## Agent skills` in `CLAUDE.md` (else `AGENTS.md`), once. An existing guide is never rewritten; one that does not name `q:intake` is reported with a step to replace it. Both files are repo changes for the user to commit.
4. Prints the steps only a human can do: create and install the GitHub Apps (`graft setup app`), fill in `graft.app`/`graft.botLogin`/`worker.graftApp`, start the services (`oakgreen start`), and optionally write mycelium's settings to `~/.mycelium/env`.

Running it again creates nothing.

## Tests

```sh
npm test
```

The GitHub client, command runner, spawner and `PATH` lookup are injected; nothing touches the network, GitHub or `claude`. Services run against a fake launchd that, like the real one, refuses a bootstrap while the old process is still stopping.

## License

AGPL-3.0-only
