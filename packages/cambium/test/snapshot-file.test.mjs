// @ts-check
/**
 * The snapshots file (snapshot-file.mjs): the daemon writes each repo's full snapshot every tick, and `run … --follow`
 * beside a live daemon reads it instead of GitHub (graph-engine.mjs `snapshotSource`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonFeed, readSnapshots, SNAPSHOTS_VERSION, snapshotsFile, writeSnapshots } from '../src/snapshot-file.mjs'
import { FEED_POLL_MS, runIssue } from '../src/graph-engine.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const OTHER = 'o/other'

test('a tick writes every repo’s full snapshot; a repo it could not read is an error, not a fresh board', async () => {
  const h = harness({
    issues: [{ number: 1, labels: ['q:intake'] }],
    config: {
      repos: [
        { slug: SLUG, path: '/repo' },
        { slug: OTHER, path: '/other' },
      ],
    },
  })
  h.deps.store.setMode('paused')
  const read = h.deps.github.read
  h.deps.github = {
    ...h.deps.github,
    read: async (slug) => (slug === OTHER ? Promise.reject(new Error('502')) : read(slug)),
  }
  /** @type {import('../src/snapshot-file.mjs').SnapshotsFile[]} */
  const written = []
  h.deps.snapshots = { write: (f) => void written.push(f) }
  await tick(h.deps)
  assert.equal(written.length, 1)
  const [file] = written
  assert.equal(file.version, SNAPSHOTS_VERSION)
  assert.equal(file.writtenAt, new Date(h.clock.now()).toISOString())
  const [mine, other] = file.repos
  assert.deepEqual([mine.slug, mine.ok, mine.error], [SLUG, true, null])
  assert.equal(mine.fetchedAt, new Date(h.clock.now()).toISOString())
  assert.deepEqual(
    mine.snapshot.issues.map((/** @type {any} */ i) => i.number),
    [1],
  )
  assert.deepEqual([other.slug, other.ok, other.error, other.snapshot], [OTHER, false, '502', null])
})

test('writeSnapshots is atomic (no temp file left); readSnapshots refuses a missing, broken or other-version file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-snaps-'))
  const path = join(dir, 'snapshots.json')
  assert.equal(readSnapshots(path), null)
  const file = snapshotsFile({
    repos: [SLUG],
    snaps: new Map([[SLUG, { issues: new Map(), prs: [] }]]),
    readErrors: new Map(),
    fetchedAt: 0,
    now: 1,
    tickSeconds: 30,
  })
  writeSnapshots(path, file)
  assert.deepEqual(readdirSync(dir), ['snapshots.json'])
  assert.deepEqual(readSnapshots(path), file)
  writeFileSync(path, '{"version":')
  assert.equal(readSnapshots(path), null)
  writeFileSync(path, JSON.stringify({ ...file, version: SNAPSHOTS_VERSION + 1 }))
  assert.equal(readSnapshots(path), null)
})

test('daemonFeed: live only with a fresh heartbeat and a file that holds the repo', () => {
  const file = snapshotsFile({
    repos: [SLUG, OTHER],
    snaps: new Map([[SLUG, { issues: new Map([[3, /** @type {any} */ ({ number: 3, labels: [] })]]), prs: [] }]]),
    readErrors: new Map([[OTHER, 'boom']]),
    fetchedAt: 1000,
    now: 2000,
    tickSeconds: 30,
  })
  let now = 2000
  let hb = /** @type {any} */ ({ tick: { finishedAt: new Date(2000).toISOString() }, daemon: { tickSeconds: 30 } })
  /** @type {any} */
  let f = file
  const feed = daemonFeed({ readHeartbeat: () => hb, readSnapshots: () => f, now: () => now })
  const got = /** @type {any} */ (feed.latest(SLUG))
  assert.equal(got.live, true)
  assert.equal(got.fetchedAt, 1000)
  assert.deepEqual([...got.snap.issues.keys()], [3])
  assert.deepEqual(feed.latest(OTHER), { live: true, snap: null, fetchedAt: 1000 }, 'errored repo: wait, not fresh')
  assert.deepEqual(feed.latest('o/unknown'), { live: false })
  now = 2000 + 91_000
  assert.deepEqual(feed.latest(SLUG), { live: false }, 'stale heartbeat')
  now = 2000
  hb = null
  assert.deepEqual(feed.latest(SLUG), { live: false }, 'no heartbeat')
  hb = { tick: { finishedAt: new Date(2000).toISOString() }, daemon: { tickSeconds: 30 } }
  f = null
  assert.deepEqual(feed.latest(SLUG), { live: false }, 'no usable file')
})

/**
 * Issue 6 submitted as PR 66 (CI pending), and a "daemon" beside it: `tick()` writes the snapshots file and a
 * heartbeat. The follower's own GitHub read throws, so any read it makes fails the test.
 */
async function besideDaemon() {
  const h = harness({
    issues: [{ number: 6, labels: ['q:task'] }],
    config: { engine: 'graph', repos: [{ slug: SLUG, path: '/repo', merge: 'green' }] },
  })
  const start = h.spawner.start
  h.spawner.start = async (spec) => {
    const started = await start(spec)
    h.gh.addPr({ number: 66, closes: [6], checks: 'PENDING', autoMerge: false })
    return started
  }
  const out = () => {}
  assert.deepEqual(await runIssue(h.deps, { graph: 'task', slug: SLUG, number: 6, out }), { ok: true })
  assert.equal(h.gh.marker(6)?.node, 'submit')

  const dir = mkdtempSync(join(tmpdir(), 'cambium-feed-'))
  const paths = { heartbeat: join(dir, 'state.json'), snapshots: join(dir, 'snapshots.json') }
  /** @type {unknown} */
  let hb = null
  /** The daemon's tick, as far as a follower sees it: read, then the snapshots file and the heartbeat. */
  const daemonTick = async () => {
    const snap = await h.gh.github.read(SLUG)
    const now = h.clock.now()
    writeSnapshots(
      paths.snapshots,
      snapshotsFile({
        repos: [SLUG],
        snaps: new Map([[SLUG, snap]]),
        readErrors: new Map(),
        fetchedAt: now,
        now,
        tickSeconds: 30,
      }),
    )
    hb = { tick: { finishedAt: new Date(now).toISOString() }, daemon: { tickSeconds: 30 } }
  }
  await daemonTick()
  let followerReads = 0
  const follower = {
    ...h.deps,
    github: {
      ...h.deps.github,
      read: async () => {
        followerReads++
        return h.gh.github.read(SLUG)
      },
    },
    daemonFeed: daemonFeed({
      readHeartbeat: () => hb,
      readSnapshots: () => readSnapshots(paths.snapshots),
      now: () => h.clock.now(),
    }),
  }
  return { h, follower, daemonTick, reads: () => followerReads }
}

test('run pr --follow beside a live daemon reads only the daemon’s snapshots: no GitHub reads of its own', async () => {
  const { h, follower, daemonTick, reads } = await besideDaemon()
  /** @type {number[]} */
  const slept = []
  const sleep = async (/** @type {number} */ ms) => {
    slept.push(ms)
    h.clock.advance(ms)
    // The daemon ticks every other poll; CI goes green, then the PR merges.
    if (slept.length === 2) h.gh.pr(66).checks = 'SUCCESS'
    if (slept.length === 4) h.gh.pr(66).state = 'MERGED'
    if (slept.length % 2 === 0) await daemonTick()
  }
  /** @type {string[]} */
  const lines = []
  const r = await runIssue(follower, {
    graph: 'pr',
    slug: SLUG,
    number: 6,
    follow: true,
    out: (l) => lines.push(l),
    sleep,
  })
  assert.deepEqual(r, { ok: true })
  assert.equal(reads(), 0, 'the follower made no snapshot reads of its own')
  assert.ok(
    slept.every((ms) => ms === FEED_POLL_MS),
    'it waits for the next snapshot, not a tick of its own',
  )
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'mergePull').map((c) => c.args),
    [[SLUG, 66]],
  )
  assert.equal(h.gh.issue(6).state, 'CLOSED')
  assert.match(lines[0], /PR #66: not assessed \(CI PENDING, open\)/)
  assert.match(lines.at(-1) ?? '', /o\/r#6: closed/)
})

test('a follower waits for a snapshot read after its last turn, not the one it already used', async () => {
  const { h, follower, daemonTick, reads } = await besideDaemon()
  let ticks = 0
  const sleep = async (/** @type {number} */ ms) => {
    h.clock.advance(ms)
    if (++ticks === 3) {
      h.gh.pr(66).state = 'MERGED'
      await daemonTick()
    }
  }
  assert.deepEqual(
    await runIssue(follower, { graph: 'pr', slug: SLUG, number: 6, follow: true, out: () => {}, sleep }),
    {
      ok: true,
    },
  )
  assert.equal(ticks, 3, 'it polled until the daemon wrote a newer snapshot')
  assert.equal(reads(), 0)
  assert.equal(h.gh.issue(6).state, 'CLOSED')
})

test('a stale heartbeat: the follower reads GitHub itself every tickSeconds, as without a daemon', async () => {
  const { h, follower, reads } = await besideDaemon()
  h.clock.advance(91_000)
  /** @type {number[]} */
  const slept = []
  const sleep = async (/** @type {number} */ ms) => {
    slept.push(ms)
    h.gh.pr(66).state = 'MERGED'
  }
  assert.deepEqual(
    await runIssue(follower, { graph: 'pr', slug: SLUG, number: 6, follow: true, out: () => {}, sleep }),
    {
      ok: true,
    },
  )
  assert.deepEqual(slept, [30_000])
  assert.equal(reads(), 2)
  assert.equal(h.gh.issue(6).state, 'CLOSED')
})

test('a missing snapshots file: the follower reads GitHub itself', async () => {
  const { h, follower, reads } = await besideDaemon()
  const gone = {
    ...follower,
    daemonFeed: daemonFeed({
      readHeartbeat: () => ({
        tick: { finishedAt: new Date(h.clock.now()).toISOString() },
        daemon: { tickSeconds: 30 },
      }),
      readSnapshots: () => null,
      now: () => h.clock.now(),
    }),
  }
  h.gh.pr(66).state = 'MERGED'
  assert.deepEqual(await runIssue(gone, { graph: 'pr', slug: SLUG, number: 6, follow: true, out: () => {} }), {
    ok: true,
  })
  assert.equal(reads(), 1)
  assert.equal(h.gh.issue(6).state, 'CLOSED')
})

test('a daemon that cannot read the repo for three ticks: the follower stops waiting and reads GitHub', async () => {
  const { h, follower, reads } = await besideDaemon()
  const errored = { ...follower, daemonFeed: { latest: () => ({ live: true, snap: null, fetchedAt: h.clock.now() }) } }
  h.gh.pr(66).state = 'MERGED'
  /** @type {number[]} */
  const slept = []
  const sleep = async (/** @type {number} */ ms) => void slept.push(ms)
  assert.deepEqual(
    await runIssue(errored, { graph: 'pr', slug: SLUG, number: 6, follow: true, out: () => {}, sleep }),
    {
      ok: true,
    },
  )
  assert.equal(slept.length, (3 * 30_000) / FEED_POLL_MS + 1)
  assert.equal(reads(), 1)
  assert.equal(h.gh.issue(6).state, 'CLOSED')
})

test('a run without --follow reads GitHub even beside a live daemon', async () => {
  const { follower, reads } = await besideDaemon()
  assert.deepEqual(await runIssue(follower, { graph: 'pr', slug: SLUG, number: 6, out: () => {} }), { ok: true })
  assert.equal(reads(), 1)
})
