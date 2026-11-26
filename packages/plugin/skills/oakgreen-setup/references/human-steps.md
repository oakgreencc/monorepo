# Steps only the human can do

Each one: tell the user **why** it is theirs, give the exact command or page, wait for "done", then run the **check**. Do not move on while the check fails; show its output and help.

In Claude Code, a command the human runs can be typed in the prompt with a `!` prefix (`! graft setup`), which runs it as them in this session and shows you the output. In other tools (Kiro), they run it in their own terminal and tell you when it is done.

## Node ≥ 22.13

Why theirs: the Node install is the user's choice (nvm, Homebrew, the official installer) and may need their password.

Do: install Node 22.13 or newer by their usual means, open a new shell.

Check: `node --version` is `v22.13.0` or later (`oakgreen doctor`'s `node` line).

## Claude Code (for cambium's workers)

Why theirs: it signs in with their Anthropic account.

Do: install Claude Code (https://claude.com/claude-code, or `npm install -g @anthropic-ai/claude-code`), run `claude` once and sign in.

Check: `command -v claude` prints a path (`claude on PATH` in the doctor). cambium's launchd agent captures `PATH` at install, so if `claude` was installed after `oakgreen start cambium`, re-run `cambium install` (with a yes) and `oakgreen reload cambium`.

## GitHub App and repository

Why theirs: creating a GitHub App happens in their browser on their GitHub account; GitHub hands the App's private key to this machine; installing it on repos and the branch ruleset need an owner or admin.

Do, from inside the repository's clone:

```
! graft setup          # creates the App if the owner has none, installs it, then bootstraps the repo
```

or step by step: `! graft setup app` (the App; `--manual` registers an App they already have), then `! graft setup project` (writes `.graft.json`, CODEOWNERS and `.claude/settings.json`, and the base branch's ruleset). In the browser: confirm the App's creation, then install it on the repositories agents should work in.

Afterwards they commit the files `graft setup project` wrote, the normal human way, and restart any Claude Code session open in that repo (its git env and hooks load at session start).

Check: `graft doctor` exits 0, and its lines include `App credentials (<slug>)` and `App installed on <owner/name>`. Note the slug: cambium's config needs it (`graft.app`, `graft.botLogin` = `<slug>[bot]`, `worker.graftApp`).

A second App for workers is optional: the same steps with `graft setup app --name <name>`; check that `graft doctor` with `GRAFT_APP=<name>` passes.

## mycelium credentials

Why theirs: bot tokens and API keys come from the provider's console under their account, and should never be pasted into a chat.

Do: create the credentials for each chosen source (see the mycelium README "Configuration" for the exact permissions):

- discord: a bot with View Channel and Read Message History (plus Send Messages when notify is on), invited to the server; its token, and the channel ids (`forum:<id>` for forums, plus `MYCELIUM_DISCORD_GUILD`).
- asc: an App Store Connect API key (key id, issuer id, the `.p8`), and the app's numeric id.
- play: a Google Cloud service account with access in Play Console, its key JSON (a path is fine), and the package name. Vitals also needs the Play Developer Reporting API enabled and View app information.

Then they write the credentials into `~/.oakgreen/env`, one `KEY=value` per line, and make it private. Give them the key names, not values, e.g.:

```
MYCELIUM_DISCORD_TOKEN=...
```

```
! chmod 600 ~/.oakgreen/env
```

The settings that are not credentials go in the `mycelium` section of `~/.oakgreen/forest.json`, which you may write (show the diff, ask): `{ "repo": "owner/name", "discordChannels": ["123", "forum:456"], "discordGuild": "789" }`. The credentials (`MYCELIUM_DISCORD_TOKEN`, `MYCELIUM_ASC_KEY_ID`, `MYCELIUM_ASC_ISSUER_ID`, `MYCELIUM_ASC_KEY_P8`, `MYCELIUM_PLAY_KEY_JSON`, `MYCELIUM_DEVICELOG_USER`, `_PASSWORD`, `_TOTP_SECRET`) never go there; mycelium refuses them in `forest.json`.

Check, without printing values:

```sh
stat -f '%Lp' ~/.oakgreen/env                 # 600
cut -d= -f1 ~/.oakgreen/env | grep -v '^#'    # the key names
oakgreen doctor --json                        # every "mycelium <source>" check ok
mycelium poll <source> --dry-run              # plans issues, writes nothing
```

## Tracing on AWS (only if chosen)

Why theirs: AWS credentials and account settings.

Do: enable X-Ray Transaction Search in the region, give the collector's process AWS credentials through the default chain (e.g. a profile in `~/.aws`), and set the region and workspace in `~/.oakgreen/cambium/otel/otelcol.yaml` copied from `otelcol-aws.yaml`.

Check: `otelcol-contrib validate --config ~/.oakgreen/cambium/otel/otelcol.yaml` exits 0, and `~/.oakgreen/cambium/logs/otelcol.log` shows no export errors a minute after `oakgreen restart otelcol`.
