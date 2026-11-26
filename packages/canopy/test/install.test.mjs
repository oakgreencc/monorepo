// @ts-check
/** `canopy install`: the launchd agent oakgreen starts, restarts and reloads. Nothing touches the real disk. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { LABEL, plist } from '../src/launchd.mjs'

const HOME = '/Users/me'

/** @param {string[]} argv @param {Record<string, string | undefined>} [env] */
function run(argv, env = { PATH: '/opt/bin:/usr/bin', HOME }) {
  let out = ''
  let err = ''
  /** @type {[string, string][]} */
  const wrote = []
  const code = main(argv, {
    env,
    home: HOME,
    out: (s) => (out += s),
    err: (s) => (err += s),
    write: (p, t) => wrote.push([p, t]),
  })
  return { code, out, err, wrote }
}

/** The ProgramArguments strings of a plist. @param {string} text */
const programArgs = (text) =>
  [
    ...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '').matchAll(
      /<string>(.*?)<\/string>/g,
    ),
  ].map((m) => m[1])

test('install writes a KeepAlive agent under the oakgreen label, with no serve flags in it', () => {
  const r = run(['install'])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.wrote.length, 1)
  const [path, text] = r.wrote[0]
  assert.equal(path, `${HOME}/Library/LaunchAgents/com.oakgreencc.canopy.plist`)
  assert.equal(LABEL, 'com.oakgreencc.canopy')
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(text, /<key>PATH<\/key>\s*<string>\/opt\/bin:\/usr\/bin<\/string>/, 'graft is found through PATH')
  assert.match(text, new RegExp(`<string>${HOME}/.oakgreen/canopy/logs/canopy.log</string>`))
  assert.doesNotMatch(text, /OAKGREEN_FOREST_CONFIG_PATH/, 'the default forest.json is found again, not pinned')
  const args = programArgs(text)
  assert.equal(args[0], process.execPath)
  assert.match(args[1], /bin\/canopy\.mjs$/)
  assert.deepEqual(args.slice(2), [], 'settings come from forest.json')
  assert.match(r.out, /oakgreen start canopy/)
})

test('install refuses serve flags, naming forest.json', () => {
  const r = run(['install', '--port', '4400', '--repo', 'a/b'])
  assert.equal(r.code, 2)
  assert.match(r.err, /--port --repo.*forest\.json's "canopy" section/)
  assert.equal(r.wrote.length, 0)
})

test('install --dry-run prints the agent and writes nothing; an explicit OAKGREEN_FOREST_CONFIG_PATH is carried', () => {
  const r = run(['install', '--dry-run'], { PATH: '/usr/bin', HOME, OAKGREEN_FOREST_CONFIG_PATH: '/etc/forest.json' })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.wrote.length, 0)
  assert.match(r.out, /^# would write \/Users\/me\/Library\/LaunchAgents\/com\.oakgreencc\.canopy\.plist/)
  assert.match(r.out, /<key>OAKGREEN_FOREST_CONFIG_PATH<\/key>\s*<string>\/etc\/forest\.json<\/string>/)
  assert.deepEqual(programArgs(r.out).slice(2), [])
})

test('install refuses flags canopy itself would refuse; stray arguments are errors', () => {
  assert.equal(run(['install', '--port', 'nope']).code, 2)
  assert.equal(run(['install', '--repo', 'not-a-slug']).code, 2)
  assert.equal(run(['install', '--bogus']).code, 2)
  const stray = run(['serve'])
  assert.equal(stray.code, 2)
  assert.match(stray.err, /unexpected argument serve/)
  assert.equal(run(['install', 'extra']).code, 2)
  assert.match(run(['--dry-run']).err, /--dry-run only goes with install/)
  for (const r of [run(['install', '--port', 'nope']), run(['serve'])]) assert.equal(r.wrote.length, 0)
})

test('plist escapes XML in paths and arguments', () => {
  const text = plist({ node: '/n', bin: '/b&c', home: '/h<x>', path: '/p', logFile: '/l' })
  assert.match(text, /<string>\/b&amp;c<\/string>/)
  assert.match(text, /<string>\/h&lt;x&gt;<\/string>/)
})

test("serve settings: a flag, then forest.json's canopy section, then the default", () => {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-forest-'))
  const forest = join(dir, 'forest.json')
  writeFileSync(forest, JSON.stringify({ canopy: { port: 4400, host: '127.0.0.2' } }))
  const env = { HOME: dir, OAKGREEN_FOREST_CONFIG_PATH: forest }
  const quiet = { env, client: /** @type {any} */ ({}), out: () => {}, err: () => {} }
  const fromForest = /** @type {any} */ (main([], quiet))
  assert.equal(fromForest.port, 4400)
  assert.equal(fromForest.host, '127.0.0.2')
  const fromFlag = /** @type {any} */ (main(['--port', '4500'], quiet))
  assert.equal(fromFlag.port, 4500)
  writeFileSync(forest, '{}')
  assert.equal(/** @type {any} */ (main([], quiet)).port, 4317)
})

test('only the old ~/.cambium or ~/.canopy there: canopy exits non-zero naming oakgreen config migrate', () => {
  for (const old of ['.cambium', '.canopy']) {
    const dir = mkdtempSync(join(tmpdir(), 'canopy-legacy-'))
    mkdirSync(join(dir, old))
    let err = ''
    const code = main([], { env: { HOME: dir }, home: dir, client: /** @type {any} */ ({}), err: (s) => (err += s) })
    assert.equal(code, 2)
    assert.match(err, /oakgreen config migrate/)
  }
})
