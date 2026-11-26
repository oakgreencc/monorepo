// @ts-check
/** `oakgreen config migrate` on a fixture home: the old per-service layout in, ~/.oakgreen out, no byte lost. */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { canopyFlags } from '../src/migrate.mjs'
import { run, tempDir } from './helpers.mjs'

const DB = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0xff, 0x01])
// The collector's own `${env:HOME}` syntax, spelt so it is not read as a template placeholder.
const OLD_OTEL = `exporters:\n  file/traces:\n    path: ${'$'}{env:HOME}/.cambium/otel/traces.jsonl\n`
const plist = (/** @type {string[]} */ args) =>
  `<plist><dict><key>ProgramArguments</key>\n<array>\n${args.map((a) => `<string>${a}</string>`).join('\n')}\n</array></dict></plist>\n`

/** What an old machine holds; the paths are relative to its home. */
function oldMachine() {
  const home = tempDir({
    '.cambium/config.json': JSON.stringify({
      repos: [{ slug: 'o/r', path: '~/src/r' }],
      tickSeconds: 10,
      paths: { home: '~/.cambium', logs: '~/.cambium/logs' },
    }),
    '.cambium/state.json': '{"tick":1}',
    '.cambium/queues.json': '{"q":[]}',
    '.cambium/logs/o-r-1.out.log': 'worker out\n',
    '.cambium/briefs/o__r/issue-1.md': '# brief\n',
    '.cambium/otel/traces.jsonl': '{"span":1}\n',
    '.cambium/otel/otelcol.yaml': OLD_OTEL,
    '.mycelium/env': [
      'MYCELIUM_REPO=o/r',
      "MYCELIUM_DISCORD_TOKEN='s3cret'",
      'MYCELIUM_DISCORD_CHANNELS=1,forum:2',
      'MYCELIUM_ASC_KEY_P8="-----BEGIN PRIVATE KEY-----"',
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
    ].join('\n'),
    '.mycelium/status.json': '{"sources":[]}',
    '.mycelium/logs/mycelium.log': 'polled\n',
    '.local/state/mycelium/state.json': '{"cursors":{"discord":1}}',
    '.canopy/logs/canopy.log': 'served\n',
    '.config/graft/config.json': JSON.stringify({ defaultApp: 'acme', owners: { acme: 'acme' } }),
    '.config/graft/apps/acme/app.json': '{"id":1}',
    '.config/graft/apps/acme/private-key.pem': '-----BEGIN RSA PRIVATE KEY-----\nKEY\n',
    '.config/graft/cache/token.json': '{"t":"x"}',
    '.oakgreen/proxy.json': JSON.stringify({ routes: { grafana: 3000 } }),
    '.oakgreen/logs/proxy.log': 'proxied\n',
    'Library/LaunchAgents/com.oakgreencc.canopy.plist': plist([
      '/node',
      '/canopy.mjs',
      '--port',
      '4400',
      '--repo',
      'a/b',
      '--repo',
      'c/d',
    ]),
    'Library/LaunchAgents/com.oakgreencc.cambium.plist': plist([
      '/node',
      '/cambium.mjs',
      'start',
      '--config',
      '/h/.cambium/config.json',
    ]),
    'Library/LaunchAgents/com.oakgreencc.otelcol.plist': plist([
      'exec otelcol-contrib --config "$HOME/.cambium/otel/otelcol.yaml" &gt;&gt;"$HOME/.cambium/otel/otelcol.log"',
    ]),
  })
  writeFileSync(join(home, '.cambium/cambium.db'), DB)
  chmodSync(join(home, '.config/graft/apps/acme/private-key.pem'), 0o600)
  return home
}

/** Every file under `root`: its bytes and mode. @param {string} root @returns {Record<string, { mode: number, data: string }>} */
function snapshot(root, dir = root, out = /** @type {Record<string, { mode: number, data: string }>} */ ({})) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) snapshot(root, p, out)
    else out[relative(root, p)] = { mode: statSync(p).mode & 0o777, data: readFileSync(p).toString('base64') }
  }
  return out
}

/** launchctl that knows nothing (no agent loaded), or `loaded` loaded. @param {string[]} [loaded] */
const launchctl = (loaded = []) => ({
  exec: async (/** @type {string} */ _cmd, /** @type {string[]} */ args) =>
    loaded.some((n) => args.at(-1)?.endsWith(`com.oakgreencc.${n}`))
      ? { code: 0, stdout: 'state = running\npid = 42\n', stderr: '' }
      : { code: 113, stdout: '', stderr: 'Could not find service' },
})

const migrate = (
  /** @type {string} */ home,
  /** @type {string[]} */ args = [],
  loaded = /** @type {string[]} */ ([]),
) => run(['config', 'migrate', ...args], { home, env: {}, uid: 501, ...launchctl(loaded) })

test('--dry-run prints the plan and changes nothing', async () => {
  const home = oldMachine()
  const before = snapshot(home)
  const r = await migrate(home, ['--dry-run'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /fold .*forest\.json: cambium ← .*\.cambium\/config\.json/)
  assert.match(r.out, /secret .*\.oakgreen\/env \(0600\): MYCELIUM_DISCORD_TOKEN, MYCELIUM_ASC_KEY_P8, OTEL_EXPORTER/)
  assert.match(r.out, /move .*\.cambium\/cambium\.db → .*\.oakgreen\/cambium\/cambium\.db/)
  assert.match(r.out, /move .*\.local\/state\/mycelium\/state\.json → .*\.oakgreen\/mycelium\/state\.json/)
  assert.match(r.out, /\(dry run: nothing changed\)/)
  assert.deepEqual(snapshot(home), before)
})

test('refuses while a service whose files would move is loaded, naming it, and changes nothing', async () => {
  const home = oldMachine()
  const before = snapshot(home)
  for (const args of [[], ['--dry-run']]) {
    const r = await migrate(home, args, ['cambium', 'canopy'])
    assert.equal(r.code, 1)
    assert.match(r.out, /running: cambium, canopy\. Stop first: oakgreen stop cambium canopy/)
  }
  assert.deepEqual(snapshot(home), before)
})

test('moves every file under ~/.oakgreen unchanged, folds config into forest.json and secrets into env', async () => {
  const home = oldMachine()
  const before = snapshot(home)
  const r = await migrate(home)
  assert.equal(r.code, 0, r.out)
  const after = snapshot(home)

  // State and logs: same bytes, same mode, new place.
  const moved = {
    '.cambium/state.json': '.oakgreen/cambium/state.json',
    '.cambium/queues.json': '.oakgreen/cambium/queues.json',
    '.cambium/cambium.db': '.oakgreen/cambium/cambium.db',
    '.cambium/logs/o-r-1.out.log': '.oakgreen/cambium/logs/o-r-1.out.log',
    '.cambium/briefs/o__r/issue-1.md': '.oakgreen/cambium/briefs/o__r/issue-1.md',
    '.cambium/otel/traces.jsonl': '.oakgreen/cambium/otel/traces.jsonl',
    '.mycelium/status.json': '.oakgreen/mycelium/status.json',
    '.mycelium/logs/mycelium.log': '.oakgreen/mycelium/logs/mycelium.log',
    '.local/state/mycelium/state.json': '.oakgreen/mycelium/state.json',
    '.canopy/logs/canopy.log': '.oakgreen/canopy/logs/canopy.log',
    '.config/graft/apps/acme/app.json': '.oakgreen/graft/apps/acme/app.json',
    '.config/graft/apps/acme/private-key.pem': '.oakgreen/graft/apps/acme/private-key.pem',
    '.config/graft/cache/token.json': '.oakgreen/graft/cache/token.json',
    '.oakgreen/logs/proxy.log': '.oakgreen/proxy/logs/proxy.log',
  }
  for (const [from, to] of Object.entries(moved)) {
    assert.ok(after[to], `${to} is there`)
    assert.equal(after[to].data, before[from].data, `${from} → ${to} unchanged`)
  }
  assert.equal(after['.oakgreen/graft/apps/acme/private-key.pem'].mode, 0o600)
  assert.equal(statSync(join(home, '.oakgreen/graft/apps/acme')).mode & 0o777, 0o700)

  // Config: one forest.json, no secret in it.
  const forestText = readFileSync(join(home, '.oakgreen/forest.json'), 'utf8')
  const forest = JSON.parse(forestText)
  assert.deepEqual(forest.cambium, {
    repos: [{ slug: 'o/r', path: '~/src/r' }],
    tickSeconds: 10,
    paths: { home: '~/.oakgreen/cambium', logs: '~/.oakgreen/cambium/logs' },
  })
  assert.deepEqual(forest.mycelium, { repo: 'o/r', discordChannels: '1,forum:2' })
  assert.deepEqual(forest.canopy, { port: 4400, repos: ['a/b', 'c/d'] })
  assert.deepEqual(forest.graft, { defaultApp: 'acme', owners: { acme: 'acme' } })
  assert.deepEqual(forest.proxy, { routes: { grafana: 3000 } })
  assert.doesNotMatch(forestText, /s3cret|PRIVATE KEY|TOKEN/)

  const env = readFileSync(join(home, '.oakgreen/env'), 'utf8')
  assert.equal(statSync(join(home, '.oakgreen/env')).mode & 0o777, 0o600)
  assert.match(env, /^MYCELIUM_DISCORD_TOKEN='s3cret'$/m)
  assert.match(env, /^MYCELIUM_ASC_KEY_P8='-----BEGIN PRIVATE KEY-----'$/m)
  assert.match(env, /^OTEL_EXPORTER_OTLP_ENDPOINT='http:\/\/127\.0\.0\.1:4318'$/m)
  assert.doesNotMatch(env, /MYCELIUM_REPO/)

  // The collector follows; agents naming old paths are gone for `oakgreen start` to rewrite.
  assert.match(
    readFileSync(join(home, '.oakgreen/cambium/otel/otelcol.yaml'), 'utf8'),
    /\.oakgreen\/cambium\/otel\/traces/,
  )
  const otel = readFileSync(join(home, 'Library/LaunchAgents/com.oakgreencc.otelcol.plist'), 'utf8')
  assert.match(otel, /\$HOME\/\.oakgreen\/cambium\/otel\/otelcol\.yaml/)
  assert.match(otel, /\$HOME\/\.oakgreen\/cambium\/logs\/otelcol\.log/)
  assert.ok(existsSync(join(home, '.oakgreen/cambium/logs')))
  assert.ok(!existsSync(join(home, 'Library/LaunchAgents/com.oakgreencc.cambium.plist')))
  assert.ok(!existsSync(join(home, 'Library/LaunchAgents/com.oakgreencc.canopy.plist')))

  // Nothing left behind.
  for (const old of [
    '.cambium',
    '.mycelium',
    '.canopy',
    '.config/graft',
    '.local/state/mycelium',
    '.oakgreen/proxy.json',
    '.oakgreen/logs',
  ])
    assert.ok(!existsSync(join(home, old)), `${old} is gone`)
  assert.match(r.out, /Migrated\. Start the services again: oakgreen start/)

  // Doctor agrees, and a second run has nothing to do.
  const doctor = await run(['doctor', '--json'], {
    home,
    cwd: home,
    env: {},
    exec: async () => ({ code: 127, stdout: '', stderr: '' }),
    github: { listLabels: async () => [], createLabel: async () => {} },
    which: () => null,
  })
  const checks = Object.fromEntries(JSON.parse(doctor.out).checks.map((/** @type {any} */ c) => [c.name, c]))
  assert.equal(checks['old paths'].ok, true, checks['old paths'].detail)
  assert.equal(checks['env file'].ok, true)
  assert.equal(checks['forest.json'].ok, true)
  const again = await migrate(home)
  assert.equal(again.code, 0)
  assert.match(again.out, /Nothing to migrate/)
})

test('a section forest.json already has, or a destination that exists, stops it before any change', async () => {
  const home = oldMachine()
  writeFileSync(join(home, '.oakgreen/forest.json'), '{"cambium":{"repos":[]}}')
  const before = snapshot(home)
  const r = await migrate(home)
  assert.equal(r.code, 1)
  assert.match(r.out, /already has a "cambium" section/)
  assert.match(r.out, /Nothing changed/)
  assert.deepEqual(snapshot(home), before)
})

test('canopyFlags: serve flags from an old plist become the canopy section', () => {
  assert.deepEqual(
    canopyFlags(plist(['/n', '/b', '--host', '::1', '--cache=60', '--config', '/c.json', '--state', '/s'])),
    {
      host: '::1',
      cache: 60,
      state: '/s',
    },
  )
  assert.deepEqual(canopyFlags(plist(['/n', '/b'])), {})
})

test('the forest.mjs each service carries is one file', () => {
  const text = (/** @type {string} */ pkg) =>
    readFileSync(new URL(`../../${pkg}/src/forest.mjs`, import.meta.url), 'utf8')
  for (const pkg of ['cambium', 'canopy', 'graft'])
    assert.equal(text(pkg), text('mycelium'), `${pkg}/src/forest.mjs differs from mycelium's; copy it over`)
})
