// @ts-check
/** The settings file and `mycelium install`; nothing touches launchd or the real home. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import {
  envFilePath,
  envKeyOf,
  forestKeyOf,
  parseEnvFile,
  SECRET_KEYS,
  SETTING_KEYS,
  withEnvFile,
} from '../src/envfile.mjs'

test('parseEnvFile: comments, export, bare, double and shell single quotes', () => {
  const text = [
    '# a comment',
    'MYCELIUM_REPO=o/r',
    "export MYCELIUM_DISCORD_TOKEN='abc'",
    "MYCELIUM_X='it'\\''s'",
    'MYCELIUM_Y="a \\"b\\""',
    'not a line',
    '',
  ].join('\n')
  assert.deepEqual(parseEnvFile(text), {
    MYCELIUM_REPO: 'o/r',
    MYCELIUM_DISCORD_TOKEN: 'abc',
    MYCELIUM_X: "it's",
    MYCELIUM_Y: 'a "b"',
  })
})

/** A reader over an in-memory home. @param {Record<string, string>} files */
const reader = (files) => (/** @type {string} */ p) => files[p] ?? null
const none = () => false

test('withEnvFile: environment over ~/.oakgreen/env over forest.json over default; no files is fine', () => {
  assert.equal(envFilePath({ home: '/h' }), '/h/.oakgreen/env')
  const read = reader({
    '/h/.oakgreen/forest.json': JSON.stringify({
      mycelium: { repo: 'forest/repo', backfillHours: 12, discordChannels: ['1', 'forum:2'], discordNotify: true },
    }),
    '/h/.oakgreen/env': 'MYCELIUM_DISCORD_TOKEN=t\nMYCELIUM_BACKFILL_HOURS=6\n',
  })
  const r = withEnvFile(
    { MYCELIUM_REPO: 'env/repo', MYCELIUM_NOTIFY_INTERVAL_S: '' },
    { home: '/h', read, exists: none },
  )
  assert.equal(r.file, '/h/.oakgreen/env')
  assert.equal(r.forest, '/h/.oakgreen/forest.json')
  assert.equal(r.env.MYCELIUM_REPO, 'env/repo', 'the environment beats forest.json')
  assert.equal(r.env.MYCELIUM_BACKFILL_HOURS, '6', 'the env file beats forest.json')
  assert.equal(r.env.MYCELIUM_DISCORD_TOKEN, 't')
  assert.equal(r.env.MYCELIUM_DISCORD_CHANNELS, '1,forum:2')
  assert.equal(r.env.MYCELIUM_DISCORD_NOTIFY, 'true')
  assert.equal(r.env.MYCELIUM_NOTIFY_INTERVAL_S, undefined, 'unset everywhere: the default applies')
  assert.deepEqual(withEnvFile({ A: '1' }, { home: '/h', read: () => null, exists: none }), {
    env: { A: '1' },
    file: null,
    forest: '/h/.oakgreen/forest.json',
  })
})

test('withEnvFile: $OAKGREEN_FOREST_CONFIG_PATH names another forest.json', () => {
  const read = reader({ '/etc/forest.json': '{"mycelium":{"repo":"o/elsewhere"}}' })
  const env = { OAKGREEN_FOREST_CONFIG_PATH: '/etc/forest.json' }
  assert.equal(withEnvFile(env, { home: '/h', read, exists: none }).env.MYCELIUM_REPO, 'o/elsewhere')
})

test('withEnvFile: a credential in forest.json is refused; so is an unknown key', () => {
  const at = (/** @type {object} */ mycelium) =>
    withEnvFile(
      {},
      { home: '/h', read: reader({ '/h/.oakgreen/forest.json': JSON.stringify({ mycelium }) }), exists: none },
    )
  assert.throws(() => at({ discordToken: 'x' }), /credential; set MYCELIUM_DISCORD_TOKEN in ~\/\.oakgreen\/env/)
  assert.throws(() => at({ nope: 1 }), /not a mycelium setting/)
})

test('withEnvFile: only the old ~/.mycelium there fails, naming oakgreen config migrate', () => {
  const exists = (/** @type {string} */ p) => p === '/h/.mycelium'
  assert.throws(() => withEnvFile({}, { home: '/h', read: () => null, exists }), /oakgreen config migrate/)
})

test('forest keys: camelCase both ways', () => {
  assert.equal(envKeyOf('discordChannels'), 'MYCELIUM_DISCORD_CHANNELS')
  assert.equal(envKeyOf('notifyIntervalS'), 'MYCELIUM_NOTIFY_INTERVAL_S')
  for (const k of [...SETTING_KEYS, ...SECRET_KEYS]) assert.equal(envKeyOf(forestKeyOf(k)), k)
})

const DISCORD = { MYCELIUM_DISCORD_TOKEN: 't', MYCELIUM_DISCORD_CHANNELS: '1' }

/** @param {string[]} argv @param {Record<string, string>} env */
async function install(argv, env) {
  const lines = /** @type {string[]} */ ([])
  const writes = /** @type {[string, string][]} */ ([])
  const code = await main(argv, {
    env: { PATH: '/bin:/usr/bin', ...env },
    home: '/Users/me',
    write: (p, t) => writes.push([p, t]),
    out: (l) => lines.push(l),
    err: () => {},
  })
  return { code, out: lines.join('\n'), writes }
}

test('install: writes the agent for `run`, PATH and HOME in it, no secrets', async () => {
  const r = await install(['install'], { ...DISCORD, MYCELIUM_REPO: 'o/r' })
  assert.equal(r.code, 0)
  assert.equal(r.writes.length, 1)
  const [path, text] = r.writes[0]
  assert.equal(path, '/Users/me/Library/LaunchAgents/com.oakgreencc.mycelium.plist')
  assert.match(text, /<string>com\.oakgreencc\.mycelium<\/string>/)
  assert.match(text, /bin\/mycelium\.mjs<\/string>\n {4}<string>run<\/string>/)
  assert.match(text, /<key>PATH<\/key>\n {4}<string>\/bin:\/usr\/bin<\/string>/)
  assert.match(text, /<key>KeepAlive<\/key>\n {2}<true\/>/)
  assert.match(text, /\/Users\/me\/\.oakgreen\/mycelium\/logs\/mycelium\.log/)
  assert.doesNotMatch(text, /MYCELIUM_DISCORD_TOKEN|OAKGREEN_FOREST_CONFIG_PATH/)
  assert.match(r.out, /sources: discord/)
  assert.match(r.out, /oakgreen start mycelium/)

  const custom = await install(['install'], {
    ...DISCORD,
    MYCELIUM_REPO: 'o/r',
    OAKGREEN_FOREST_CONFIG_PATH: '/etc/f.json',
  })
  assert.match(custom.writes[0][1], /<key>OAKGREEN_FOREST_CONFIG_PATH<\/key>\n {4}<string>\/etc\/f\.json<\/string>/)
})

test('install: refused with no source or no repository; --dry-run prints and writes nothing', async () => {
  await assert.rejects(
    install(['install'], { MYCELIUM_REPO: 'o/r' }),
    /no source is configured.*\/Users\/me\/\.oakgreen\/forest\.json.*\/Users\/me\/\.oakgreen\/env/,
  )
  await assert.rejects(install(['install'], DISCORD), /MYCELIUM_REPO/)
  const dry = await install(['install', '--dry-run'], {})
  assert.equal(dry.code, 0)
  assert.equal(dry.writes.length, 0)
  assert.match(dry.out, /^# would write \/Users\/me\/Library\/LaunchAgents\/com\.oakgreencc\.mycelium\.plist/)
})
