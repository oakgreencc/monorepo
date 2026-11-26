// @ts-check
/** graft's machine settings are forest.json's `graft` section; App keys live under ~/.oakgreen/graft. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appFor, graftHome, loadUserConfig } from '../src/config.mjs'

const home = () => mkdtempSync(join(tmpdir(), 'graft-forest-'))

test('graftHome: $GRAFT_HOME, else ~/.oakgreen/graft', () => {
  assert.equal(graftHome({ HOME: '/h' }), '/h/.oakgreen/graft')
  assert.equal(graftHome({ HOME: '/h', GRAFT_HOME: '/g' }), '/g')
})

test("loadUserConfig: forest.json's graft section; $OAKGREEN_FOREST_CONFIG_PATH names another file", () => {
  const h = home()
  mkdirSync(join(h, '.oakgreen'))
  writeFileSync(join(h, '.oakgreen', 'forest.json'), JSON.stringify({ graft: { defaultApp: 'a' }, cambium: {} }))
  assert.deepEqual(loadUserConfig({ HOME: h }), { defaultApp: 'a' })
  writeFileSync(join(h, 'other.json'), JSON.stringify({ graft: { defaultApp: 'b' } }))
  assert.deepEqual(loadUserConfig({ HOME: h, OAKGREEN_FOREST_CONFIG_PATH: join(h, 'other.json') }), { defaultApp: 'b' })
  assert.deepEqual(loadUserConfig({ HOME: home() }), {}, 'no forest.json: nothing configured')
})

test('appFor: $GRAFT_APP, then the project pin, then forest.json owners, then forest.json defaultApp', () => {
  const user = { owners: { acme: 'by-owner' }, defaultApp: 'fallback' }
  assert.equal(appFor({ owner: 'Acme', project: { app: 'pinned' }, user, env: { GRAFT_APP: 'env' } }), 'env')
  assert.equal(appFor({ owner: 'Acme', project: { app: 'pinned' }, user, env: {} }), 'pinned')
  assert.equal(appFor({ owner: 'Acme', project: null, user, env: {} }), 'by-owner')
  assert.equal(appFor({ owner: 'other', project: null, user, env: {} }), 'fallback')
  assert.equal(appFor({ owner: 'other', project: null, user: {}, env: {} }), null)
})

test('only the old ~/.config/graft there: graft refuses, naming oakgreen config migrate', () => {
  const h = home()
  mkdirSync(join(h, '.config', 'graft'), { recursive: true })
  assert.throws(() => loadUserConfig({ HOME: h }), /\.config\/graft.*oakgreen config migrate/)
  assert.doesNotThrow(
    () => loadUserConfig({ HOME: h, GRAFT_HOME: join(h, 'g') }),
    'an explicit GRAFT_HOME is not checked',
  )
  mkdirSync(join(h, '.oakgreen'))
  writeFileSync(join(h, '.oakgreen', 'forest.json'), '{"graft":{}}')
  assert.doesNotThrow(() => loadUserConfig({ HOME: h }))
})
