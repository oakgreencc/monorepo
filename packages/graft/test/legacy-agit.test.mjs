// @ts-check
/**
 * graft was called agit. A machine or repo set up under the old name keeps
 * working, and the old names stay inside the protection: an agent cannot
 * step around a gate by spelling it the old way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { locateProjectConfig } from '../src/config.mjs'
import { grantsItself } from '../src/hooks/guard-protected.mjs'
import { keyDiffers, policyFrom } from '../src/protected.mjs'
import { isGraftHelper, mergeSettings } from '../src/setup/settings.mjs'

const reader = (files) => (path) => files[path] ?? null

test('config: .agit.json and package.json "agit" are still read', () => {
  assert.equal(
    locateProjectConfig(reader({ '.agit.json': '{"baseBranch":"develop"}' })).text,
    '{"baseBranch":"develop"}',
  )
  const pkg = locateProjectConfig(reader({ 'package.json': JSON.stringify({ agit: { baseBranch: 'develop' } }) }))
  assert.equal(pkg.source, 'package.json')
  assert.deepEqual(JSON.parse(String(pkg.text)), { baseBranch: 'develop' })
})

test('config: an old and a new policy together are refused, as two new ones are', () => {
  assert.throws(() => locateProjectConfig(reader({ '.graft.json': '{}', '.agit.json': '{}' })), /both hold a policy/)
  assert.throws(
    () => locateProjectConfig(reader({ '.graft.json': '{}', 'package.json': JSON.stringify({ agit: {} }) })),
    /both hold a policy/,
  )
})

test('protection: .agit.json stays self-protected, and editing the "agit" key is a policy edit', () => {
  const p = policyFrom(reader({}))
  assert.equal(p.check('.agit.json')?.tier, 'protected')
  const before = JSON.stringify({ name: 'x', agit: { baseBranch: 'develop' } })
  assert.equal(keyDiffers(before, JSON.stringify({ name: 'x', agit: { baseBranch: 'main' } }), 'graft'), true)
  assert.equal(keyDiffers(before, JSON.stringify({ name: 'y', agit: { baseBranch: 'develop' } }), 'graft'), false)
})

test('guard: an agent granting itself is caught under either name', () => {
  assert.equal(grantsItself('graft maintainer grant "x" --scope protected'), true)
  assert.equal(grantsItself('agit maintainer grant "x" --scope protected'), true)
  assert.equal(grantsItself('node /usr/lib/agit.mjs maintainer grant x'), true)
  assert.equal(grantsItself('agit maintainer status'), false)
})

test('settings: the old credential helper is recognised; old hook lines are upgraded, not duplicated', () => {
  assert.equal(isGraftHelper('!agit credential'), true)
  assert.equal(isGraftHelper('!graft credential'), true)
  const existing = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'agit hook guard-protected' }] }] },
  }
  const out = mergeSettings(existing, {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'graft hook guard-protected' }] }] },
  })
  assert.deepEqual(
    out.hooks.PreToolUse[0].hooks.map((h) => h.command),
    ['graft hook guard-protected'],
  )
})
