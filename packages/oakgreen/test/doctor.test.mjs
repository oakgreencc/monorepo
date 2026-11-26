// @ts-check
import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { satisfies } from '../src/doctor.mjs'
import { ALL_LABELS, NOW, fakeExec, fakeGithub, run, tempDir } from './helpers.mjs'

const beat = (/** @type {number} */ agoS) =>
  JSON.stringify({
    version: 1,
    mode: 'running',
    daemon: { tickSeconds: 30 },
    tick: { finishedAt: new Date(NOW - agoS * 1000).toISOString() },
  })

function healthy() {
  const home = tempDir({
    '.oakgreen/forest.json': JSON.stringify({ cambium: { repos: [{ slug: 'o/r', path: '/x' }] } }),
    '.oakgreen/cambium/state.json': beat(10),
  })
  const cwd = tempDir({
    '.git/HEAD': 'ref: refs/heads/main\n',
    'canker.json': '{}',
    'package.json': '{"deadwood":{}}',
    'docs/agents/triage-labels.md': 'File issues with `q:intake`.',
  })
  const gh = fakeGithub({ 'o/r': [...ALL_LABELS, 'bug'] })
  const { exec, calls } = fakeExec({
    graft: () => ({ stdout: '✓ node 22\n✓ repository o/r\n' }),
    cambium: () => ({ stdout: JSON.stringify({ mode: 'running', heartbeat: {} }) }),
  })
  return {
    calls,
    gh,
    ports: { home, cwd, env: {}, exec, github: gh.client, which: (/** @type {string} */ n) => `/bin/${n}` },
  }
}

test('a healthy machine passes every check and exits 0', async () => {
  const { ports, calls, gh } = healthy()
  const r = await run(['doctor'], ports)
  assert.equal(r.code, 0, r.out)
  for (const name of [
    'node',
    'graft doctor',
    'claude on PATH',
    'forest.json',
    'env file',
    'old paths',
    'cambium config',
    'cambium status',
    'cambium heartbeat',
    'queue labels o/r',
    'mycelium',
    'canker config',
    'deadwood config',
    'label guide',
  ]) {
    assert.match(r.out, new RegExp(`^✓ ${name}:`, 'm'), name)
  }
  assert.doesNotMatch(r.out, /✗/)
  assert.match(r.out, /^✓ graft doctor: 2 checks passed$/m)
  assert.equal(calls[0].args.at(-1), 'doctor')
  assert.deepEqual(calls[1].args.slice(-4, -1), ['status', '--json', '--config'])
  assert.equal(gh.created.length, 0)
})

test('--json reports each check with ok, required and fix', async () => {
  const { ports } = healthy()
  const r = await run(['doctor', '--json'], ports)
  const report = JSON.parse(r.out)
  assert.equal(report.ok, true)
  assert.ok(report.checks.every((/** @type {any} */ c) => 'ok' in c && 'required' in c && 'fix' in c && 'detail' in c))
})

test('failures print ✗ with a fix hint and exit 1', async () => {
  const home = tempDir({ '.oakgreen/cambium/state.json': beat(600) })
  const cwd = tempDir({ '.git/HEAD': '' })
  const gh = fakeGithub({ 'o/r': ['q:intake', 'q:task'] })
  const { exec } = fakeExec({ graft: () => ({ code: 1, stdout: '✓ node 22\n✗ App installed on o/r\n✗ CODEOWNERS\n' }) })
  const r = await run(['doctor', '--repo', 'o/r', '--json'], {
    home,
    cwd,
    env: { MYCELIUM_DISCORD_TOKEN: 't' },
    exec,
    github: gh.client,
    which: () => null,
    nodeVersion: '20.11.0',
  })
  assert.equal(r.code, 1)
  const by = Object.fromEntries(JSON.parse(r.out).checks.map((/** @type {any} */ c) => [c.name, c]))
  assert.equal(by.node.ok, false)
  assert.equal(by['graft doctor'].detail, '2 failing: App installed on o/r; CODEOWNERS')
  assert.equal(by['claude on PATH'].ok, false)
  assert.equal(by['forest.json'].fix, 'oakgreen setup')
  assert.equal(by['cambium config'].fix, 'oakgreen setup')
  assert.equal(by['cambium status'].detail, 'skipped: no usable cambium config')
  assert.match(by['cambium heartbeat'].detail, /600s ago/)
  assert.match(by['queue labels o/r'].detail, /missing q:human q:promote running why:budget why:reject why:approve/)
  assert.equal(by['queue labels o/r'].fix, 'oakgreen setup --repo o/r')
  assert.deepEqual(by['mycelium discord'].fix, 'set MYCELIUM_DISCORD_CHANNELS, MYCELIUM_REPO')
  assert.equal(by['canker config'].required, false)
  assert.equal(gh.created.length, 0)

  const text = await run(['doctor', '--repo', 'o/r'], {
    home,
    cwd,
    env: {},
    exec,
    github: gh.client,
    which: () => null,
  })
  assert.match(text.out, /^✗ claude on PATH: not found\n {4}fix: install Claude Code/m)
  assert.match(text.out, /^✗ canker config: .* \(optional\)$/m)
})

test('cambium status fails when cambium is missing or has never ticked', async () => {
  const { ports } = healthy()
  const missing = await run(['doctor', '--json'], { ...ports, exec: fakeExec({ graft: () => ({}) }).exec })
  const byMissing = JSON.parse(missing.out).checks.find((/** @type {any} */ c) => c.name === 'cambium status')
  assert.equal(byMissing.fix, 'npm install -g @oakgreencc/cambium')
  const idle = fakeExec({ graft: () => ({}), cambium: () => ({ stdout: '{"mode":"paused","heartbeat":null}' }) })
  const never = await run(['doctor', '--json'], { ...ports, exec: idle.exec })
  const byNever = JSON.parse(never.out).checks.find((/** @type {any} */ c) => c.name === 'cambium status')
  assert.deepEqual([byNever.ok, byNever.detail], [false, 'mode paused, no heartbeat'])
  assert.equal(never.code, 1)
})

test('optional checks alone do not fail the run', async () => {
  const { ports } = healthy()
  const r = await run(['doctor'], { ...ports, cwd: tempDir({ '.git/HEAD': '' }) })
  assert.equal(r.code, 0)
  assert.match(r.out, /✗ deadwood config/)
})

test('no configured repository is a failed label check', async () => {
  const { ports } = healthy()
  const home = tempDir({ '.oakgreen/forest.json': '{"cambium":{}}' })
  const r = await run(['doctor', '--json'], { ...ports, home })
  const labels = JSON.parse(r.out).checks.find((/** @type {any} */ c) => c.name === 'queue labels')
  assert.equal(labels.ok, false)
  assert.equal(r.code, 1)
})

test('--config and $OAKGREEN_FOREST_CONFIG_PATH choose forest.json', async () => {
  const { ports } = healthy()
  const dir = tempDir({
    'c.json': JSON.stringify({ cambium: { repos: [{ slug: 'a/b' }], paths: { home: '/nowhere' } } }),
  })
  const gh = fakeGithub({ 'a/b': ALL_LABELS.slice() })
  const viaEnv = await run(['doctor', '--json'], {
    ...ports,
    env: { OAKGREEN_FOREST_CONFIG_PATH: `${dir}/c.json` },
    github: gh.client,
  })
  const names = JSON.parse(viaEnv.out).checks.map((/** @type {any} */ c) => c.name)
  assert.ok(names.includes('queue labels a/b'))
  const viaFlag = await run(['doctor', '--json', '--config', `${dir}/c.json`], { ...ports, github: gh.client })
  const checks = JSON.parse(viaFlag.out).checks
  assert.match(checks.find((/** @type {any} */ c) => c.name === 'cambium heartbeat').detail, /\/nowhere\/state\.json/)
})

/** @param {Awaited<ReturnType<typeof run>>} r @param {string} name */
const checkOf = (r, name) => JSON.parse(r.out).checks.find((/** @type {any} */ c) => c.name === name)

test('forest.json that does not parse fails its check, naming the file', async () => {
  const { ports } = healthy()
  writeFileSync(join(ports.home, '.oakgreen', 'forest.json'), '{ nope')
  const r = await run(['doctor', '--json'], ports)
  const c = checkOf(r, 'forest.json')
  assert.equal(c.ok, false)
  assert.match(c.detail, /forest\.json: /)
  assert.match(c.fix, /fix the JSON/)
  assert.equal(r.code, 1)
})

test('env file: missing passes; 0600 passes; anything looser fails with a chmod fix', async () => {
  const { ports } = healthy()
  const env = join(ports.home, '.oakgreen', 'env')
  writeFileSync(env, 'MYCELIUM_DISCORD_TOKEN=t\n')
  chmodSync(env, 0o644)
  const loose = await run(['doctor', '--json'], ports)
  assert.deepEqual([checkOf(loose, 'env file').ok, checkOf(loose, 'env file').fix], [false, `chmod 600 ${env}`])
  assert.equal(loose.code, 1)
  chmodSync(env, 0o600)
  assert.equal(checkOf(await run(['doctor', '--json'], ports), 'env file').ok, true)
})

test('old paths: any pre-forest file left fails, pointing at oakgreen config migrate', async () => {
  const { ports } = healthy()
  for (const old of ['.cambium/state.json', '.mycelium/env', '.config/graft/config.json', '.oakgreen/proxy.json']) {
    const home = tempDir({ [old]: '{}', '.oakgreen/forest.json': '{"cambium":{"repos":[]}}' })
    const r = await run(['doctor', '--json'], { ...ports, home })
    const c = checkOf(r, 'old paths')
    assert.equal(c.ok, false, old)
    assert.match(c.detail, new RegExp(old.split('/')[0].replace('.', '\\.')))
    assert.equal(c.fix, 'oakgreen config migrate')
  }
})

test('satisfies handles the >= ranges the stack declares', () => {
  assert.ok(satisfies('22.0.0', '>=22'))
  assert.ok(satisfies('v23.1.0', '>=22.13'))
  assert.ok(!satisfies('22.12.9', '>=22.13'))
  assert.ok(!satisfies('22.0.0', '^22'))
})
