// @ts-check
/** cambium's config is forest.json's `cambium` section; the old ~/.cambium is refused, naming the migration. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.mjs'
import { configPath, loadConfig } from '../src/config.mjs'

const home = () => mkdtempSync(join(tmpdir(), 'cambium-forest-'))

test('configPath: --config, then $OAKGREEN_FOREST_CONFIG_PATH, then ~/.oakgreen/forest.json', () => {
  const env = { HOME: '/h', OAKGREEN_FOREST_CONFIG_PATH: '/e/forest.json' }
  assert.equal(configPath('/f/forest.json', env), '/f/forest.json')
  assert.equal(configPath(undefined, env), '/e/forest.json')
  assert.equal(configPath(undefined, { HOME: '/h' }), '/h/.oakgreen/forest.json')
})

test('loadConfig: the cambium section over the defaults; other sections ignored; no file is the defaults', () => {
  const h = home()
  const file = join(h, 'forest.json')
  writeFileSync(
    file,
    JSON.stringify({ cambium: { tickSeconds: 5, repos: [{ slug: 'o/r', path: '/r' }] }, canopy: { port: 1 } }),
  )
  const config = loadConfig(file, { HOME: h })
  assert.equal(config.tickSeconds, 5, 'forest.json beats the default')
  assert.equal(config.stepTimeoutSeconds, 20, 'unset: the default')
  assert.deepEqual(
    config.repos.map((r) => r.slug),
    ['o/r'],
  )
  assert.equal(loadConfig(join(h, 'none.json'), { HOME: h }).repos.length, 0)
})

test('loadConfig: state defaults under ~/.oakgreen/cambium', () => {
  const h = home()
  const config = loadConfig(join(h, 'none.json'), { HOME: h })
  assert.match(config.paths.db, /\/\.oakgreen\/cambium\/cambium\.db$/)
  assert.match(config.paths.logs, /\/\.oakgreen\/cambium\/logs$/)
})

test('only the old ~/.cambium there: cambium exits non-zero naming oakgreen config migrate', async () => {
  const h = home()
  mkdirSync(join(h, '.cambium'))
  writeFileSync(join(h, '.cambium', 'config.json'), '{"repos":[]}')
  assert.throws(() => loadConfig(join(h, '.oakgreen', 'forest.json'), { HOME: h }), /oakgreen config migrate/)
  /** @type {string[]} */
  const err = []
  const code = await main(['status'], { out: () => {}, err: (l) => err.push(l), env: { HOME: h } })
  assert.equal(code, 1)
  assert.match(err.join('\n'), /\.cambium.*oakgreen config migrate/)
})
