// @ts-check
/** canopy reads cambium's queue view (snapshot.mjs) and queries GitHub only when it cannot. */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cachedIssues, cachedQueues } from '../src/github.mjs'
import { PAGE } from '../src/page.mjs'
import { group } from '../src/queues.mjs'
import { buildState } from '../src/server.mjs'
import { readQueuesFile, snapshotQueues } from '../src/snapshot.mjs'
import { graphqlAnswer, heartbeat, iso, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'

/** A GitHub client that counts its QUEUES_QUERY and ISSUE_QUERY calls. */
function fakeClient() {
  const calls = { queues: /** @type {string[]} */ ([]), issue: /** @type {string[]} */ ([]) }
  /** @type {import('../src/github.mjs').GithubClient} */
  const client = {
    async queues(slug) {
      calls.queues.push(slug)
      return group(graphqlAnswer(), slug)
    },
    async issue(slug, number) {
      calls.issue.push(`${slug}#${number}`)
      return /** @type {any} */ ({ repo: slug, number, title: 't' })
    },
  }
  return { client, calls }
}

/** The file cambium writes, as cambium's queue-view.mjs builds it: here, the fixture's board for {@link REPO}. */
function queuesFile(writtenAt = T0, slugs = [REPO]) {
  return {
    version: 1,
    writtenAt: iso(writtenAt),
    tickSeconds: 30,
    repos: slugs.map((slug) => ({
      slug,
      ok: true,
      error: null,
      fetchedAt: iso(writtenAt),
      ...group(graphqlAnswer(), slug),
    })),
  }
}

function write(/** @type {unknown} */ body) {
  const path = join(mkdtempSync(join(tmpdir(), 'canopy-queues-')), 'queues.json')
  if (body !== undefined) writeFileSync(path, JSON.stringify(body))
  return path
}

function setup(/** @type {string} */ path, now = T0) {
  const { client, calls } = fakeClient()
  const github = cachedQueues({ client, now: () => now })
  const queues = snapshotQueues({ path, github, now: () => now })
  const state = () =>
    buildState({
      statePath: write(heartbeat({ tick: { n: 1, finishedAt: iso(now) } })),
      repos: [REPO],
      queues,
      now: () => now,
    })
  return { calls, queues, state }
}

test('cambium running: rendering and refreshing the queues makes no QUEUES_QUERY call', async () => {
  const path = write(queuesFile(T0))
  const { calls, state } = setup(path, T0 + 20_000)
  for (let i = 0; i < 3; i++) {
    const s = await state()
    assert.equal(s.github.source, 'cambium')
    assert.equal(s.github.fallback, null)
    assert.equal(s.github.columns.human[0].why, 'budget')
    assert.deepEqual(
      s.github.prs.map((/** @type {any} */ p) => p.number),
      [20, 22],
    )
    assert.deepEqual(
      s.github.stranded.map((/** @type {any} */ x) => [x.number, x.pr.number]),
      [[7, 30]],
    )
    assert.equal(s.github.fetchedAt, iso(T0))
  }
  assert.deepEqual(calls.queues, [], 'no GraphQL for the queues')
})

test('file missing: canopy queries GitHub and the page says it fell back', async () => {
  const { calls, state } = setup(write(undefined))
  const s = await state()
  assert.deepEqual(calls.queues, [REPO])
  assert.equal(s.github.source, 'github')
  assert.match(String(s.github.fallback), /no queue view at .*queues\.json.*Reading the queues from GitHub instead/)
  assert.equal(s.github.columns.human[0].why, 'budget')
  // The page puts `github.fallback` in a banner.
  assert.match(
    PAGE,
    /if \(s\.github\.fallback\) out\.push\(h\('div', \{ class: 'banner warn', 'data-fallback': '' \}, h\('b', \{\}, 'Queues read from GitHub: '\), s\.github\.fallback\)\)/,
  )
})

test('file older than three ticks (cambium down): canopy queries GitHub and says why', async () => {
  const path = write(queuesFile(T0))
  const fresh = setup(path, T0 + 90_000)
  await fresh.state()
  assert.deepEqual(fresh.calls.queues, [], 'three ticks old is still fresh')
  const stale = setup(path, T0 + 91_000)
  const s = await stale.state()
  assert.deepEqual(stale.calls.queues, [REPO])
  assert.equal(s.github.source, 'github')
  assert.match(String(s.github.fallback), /91s old, past the 3 ticks of 30s allowed/)
})

test('unreadable or another version: falls back, saying which', async () => {
  const bad = join(mkdtempSync(join(tmpdir(), 'canopy-queues-')), 'queues.json')
  writeFileSync(bad, '{nope')
  const r1 = await readQueuesFile(bad, { now: T0 })
  assert.equal(r1.ok, false)
  assert.match(/** @type {any} */ (r1).reason, /cannot read/)
  const r2 = await readQueuesFile(write({ ...queuesFile(T0), version: 2 }), { now: T0 })
  assert.equal(r2.ok, false)
  assert.match(/** @type {any} */ (r2).reason, /version 2, canopy reads 1/)
})

test('a repo the file does not list is read from GitHub; the rest stay from the file', async () => {
  const path = write(queuesFile(T0, ['a/b']))
  const { client, calls } = fakeClient()
  const queues = snapshotQueues({ path, github: cachedQueues({ client, now: () => T0 }), now: () => T0 })
  const v = await queues.get(['a/b', REPO])
  assert.deepEqual(calls.queues, [REPO])
  assert.equal(v.source, 'mixed')
  assert.match(String(v.fallback), /does not list oakgreencc\/monorepo/)
  assert.deepEqual(
    v.repos.map((r) => r.slug),
    ['a/b', REPO],
  )
  assert.deepEqual(
    v.prs.map((p) => [p.repo, p.number]),
    [
      ['a/b', 20],
      ['a/b', 22],
      [REPO, 20],
      [REPO, 22],
    ],
  )
})

test('the issue pane still reads GitHub, through the cache: one ISSUE_QUERY per issue per TTL', async () => {
  const { client, calls } = fakeClient()
  let now = T0
  const issues = cachedIssues({ client, now: () => now })
  await issues.get(REPO, 5)
  await issues.get(REPO, 5)
  assert.deepEqual(calls.issue, [`${REPO}#5`])
  now += 60_000
  await issues.get(REPO, 5)
  assert.equal(calls.issue.length, 2)
})

test('resolveSettings: --queues, then config paths.queues, then <paths.home>/queues.json', async () => {
  const { resolveSettings } = await import('../src/config.mjs')
  const at = (/** @type {any} */ cfg, flags = {}) =>
    resolveSettings(
      { config: '/c.json', ...flags },
      { env: {}, home: '/h', read: () => JSON.stringify({ cambium: cfg }) },
    ).queuesPath
  assert.equal(at({}), '/h/.oakgreen/cambium/queues.json')
  assert.equal(at({ paths: { home: '~/cam' } }), '/h/cam/queues.json')
  assert.equal(at({ paths: { queues: '~/q.json' } }), '/h/q.json')
  assert.equal(at({ paths: { queues: '~/q.json' } }, { queues: '/x.json' }), '/x.json')
})
