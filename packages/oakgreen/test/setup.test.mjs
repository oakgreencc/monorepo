// @ts-check
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { graftGithub } from '../src/github.mjs'
import { ALL_LABELS, fakeExec, fakeGithub, run, tempDir } from './helpers.mjs'

const git = (/** @type {string} */ url) => fakeExec({ git: () => ({ stdout: `${url}\n` }) })

test('--dry-run prints what it would do and writes nothing', async () => {
  const home = tempDir()
  const gh = fakeGithub({ 'o/r': ['q:intake'] })
  const r = await run(['setup', '--dry-run'], {
    home,
    cwd: tempDir({ '.git/HEAD': '' }),
    env: {},
    exec: git('git@github.com:o/r.git').exec,
    github: gh.client,
  })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /would write the "cambium" section of .*\.oakgreen\/forest\.json/)
  assert.match(r.out, /would create .*\.oakgreen\/env \(0600/)
  assert.match(r.out, /would create label q:task on o\/r/)
  assert.doesNotMatch(r.out, /would create label q:intake/)
  assert.equal(gh.created.length, 0)
  assert.equal(existsSync(join(home, '.oakgreen/forest.json')), false)
  assert.equal(existsSync(join(home, '.oakgreen/env')), false)
})

test('creates the missing labels and a config skeleton, then is a no-op', async () => {
  const home = tempDir()
  const cwd = tempDir({ '.git/HEAD': '' })
  const gh = fakeGithub({ 'o/r': ['q:intake', 'bug'] })
  const ports = { home, cwd, env: {}, exec: git('https://github.com/o/r').exec, github: gh.client }

  const first = await run(['setup'], ports)
  assert.equal(first.code, 0, first.out)
  assert.deepEqual(
    gh.created.map((c) => c.label.name),
    ALL_LABELS.filter((l) => l !== 'q:intake'),
  )
  assert.ok(gh.created.every((c) => c.repo === 'o/r' && /^[0-9a-f]{6}$/.test(c.label.color)))
  const config = JSON.parse(readFileSync(join(home, '.oakgreen/forest.json'), 'utf8')).cambium
  assert.deepEqual(config.repos, [{ slug: 'o/r', path: cwd, baseBranch: 'main' }])
  assert.equal(statSync(join(home, '.oakgreen/env')).mode & 0o777, 0o600, "secrets file is the owner's alone")
  assert.doesNotMatch(readFileSync(join(home, '.oakgreen/forest.json'), 'utf8'), /TOKEN|KEY|PASSWORD/)
  assert.match(first.out, /Remaining human steps:[\s\S]*graft setup app[\s\S]*oakgreen start/)

  const before = readFileSync(join(home, '.oakgreen/forest.json'), 'utf8')
  const second = await run(['setup'], ports)
  assert.equal(second.code, 0)
  assert.equal(gh.created.length, ALL_LABELS.length - 1)
  assert.match(second.out, /exists; left as is/)
  assert.match(second.out, /queue labels on o\/r all present/)
  assert.equal(readFileSync(join(home, '.oakgreen/forest.json'), 'utf8'), before)
})

test('never overwrites an unparsable forest.json; adds the cambium section beside other sections', async () => {
  const home = tempDir({ '.oakgreen/forest.json': '{ nope' })
  const gh = fakeGithub({ 'o/r': ALL_LABELS.slice() })
  const r = await run(['setup', '--repo', 'o/r'], { home, cwd: home, env: {}, exec: git('').exec, github: gh.client })
  assert.equal(r.code, 1)
  assert.equal(readFileSync(join(home, '.oakgreen/forest.json'), 'utf8'), '{ nope')

  const other = tempDir({ '.oakgreen/forest.json': '{"canopy":{"port":4400}}' })
  const r2 = await run(['setup', '--repo', 'o/r'], {
    home: other,
    cwd: other,
    env: {},
    exec: git('').exec,
    github: gh.client,
  })
  assert.equal(r2.code, 0, r2.out)
  const forest = JSON.parse(readFileSync(join(other, '.oakgreen/forest.json'), 'utf8'))
  assert.deepEqual(forest.canopy, { port: 4400 })
  assert.equal(forest.cambium.repos[0].slug, 'o/r')
})

test('without any repository it asks for one instead of guessing', async () => {
  const home = tempDir()
  const gh = fakeGithub()
  const { exec } = fakeExec({ git: () => ({ code: 2, stderr: 'no remote' }) })
  const r = await run(['setup'], { home, cwd: home, env: {}, exec, github: gh.client })
  assert.equal(r.code, 0)
  const config = JSON.parse(readFileSync(join(home, '.oakgreen/forest.json'), 'utf8')).cambium
  assert.equal(config.repos[0].slug, 'OWNER/NAME')
  assert.match(r.out, /Set cambium\.repos\[0\]\.slug/)
  assert.match(r.out, /oakgreen setup --repo owner\/name/)
})

test('the graft-backed client lists with --paginate and creates with POST', async () => {
  const calls = /** @type {{ tool: string, args: string[] }[]} */ ([])
  const gh = graftGithub(async (tool, args) => {
    calls.push({ tool, args })
    return { code: 0, stdout: args[1] === 'GET' ? JSON.stringify([{ name: 'q:task' }]) : '{}', stderr: '' }
  })
  assert.deepEqual(await gh.listLabels('o/r'), ['q:task'])
  await gh.createLabel('o/r', { name: 'running', color: 'fbca04', description: 'd' })
  assert.deepEqual(calls[0].args, ['api', 'GET', '/repos/o/r/labels?per_page=100', '--paginate', '--repo', 'o/r'])
  assert.deepEqual(calls[1].args.slice(0, 3), ['api', 'POST', '/repos/o/r/labels'])
  assert.deepEqual(JSON.parse(calls[1].args[4]), { name: 'running', color: 'fbca04', description: 'd' })

  const failing = graftGithub(async () => ({ code: 1, stdout: '', stderr: 'HTTP 403' }))
  await assert.rejects(failing.listLabels('o/r'), /HTTP 403/)
})
