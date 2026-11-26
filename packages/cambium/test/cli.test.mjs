// @ts-check
/** The verbs and the daemon loop, against a temp config and the fake collaborators. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.mjs'
import {
  acquireLock,
  LOG_MSG_MAX,
  makeLogger,
  oneLine,
  readHeartbeat,
  runDaemon,
  writeHeartbeat,
} from '../src/daemon.mjs'
import { openStore } from '../src/store.mjs'
import { harness, SLUG } from './fakes.mjs'

function setup(/** @type {any} */ extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cambium-'))
  const cfg = join(home, 'forest.json')
  writeFileSync(
    cfg,
    JSON.stringify({ cambium: { host: 'mac', repos: [{ slug: SLUG, path: '/repo' }], paths: { home }, ...extra } }),
  )
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  const io = {
    out: (/** @type {string} */ l) => out.push(l),
    err: (/** @type {string} */ l) => err.push(l),
    env: { OAKGREEN_FOREST_CONFIG_PATH: cfg, HOME: home, PATH: '/usr/bin' },
  }
  return { home, cfg, out, err, io }
}

test('pause / drain / resume write the mode the daemon reads; status reports it', async () => {
  const s = setup()
  assert.equal(await main(['pause'], s.io), 0)
  assert.equal(openStore(join(s.home, 'cambium.db')).mode(), 'paused')
  assert.equal(await main(['drain'], s.io), 0)
  assert.equal(await main(['resume'], s.io), 0)
  assert.deepEqual(s.out, ['mode: paused', 'mode: draining', 'mode: running'])
  s.out.length = 0
  assert.equal(await main(['status'], s.io), 1, 'no heartbeat yet')
  assert.match(s.out.join('\n'), /no heartbeat/)
})

test('status reads the heartbeat file, flags a stale daemon', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 1, labels: ['q:task'] }] })
  h.deps.heartbeat = (state) => writeHeartbeat(join(s.home, 'state.json'), state)
  await (await import('../src/tick.mjs')).tick(h.deps)
  const finished = Date.parse(/** @type {any} */ (readHeartbeat(join(s.home, 'state.json'))).tick.finishedAt)
  assert.equal(await main(['status'], { ...s.io, now: () => finished + 5000 }), 0)
  const text = s.out.join('\n')
  assert.match(text, /last tick #0 5s ago/)
  assert.match(text, /queues: intake 0 · task 1/)
  assert.match(text, /o\/r#1 task attempt 1/)
  s.out.length = 0
  assert.equal(await main(['status'], { ...s.io, now: () => finished + 600_000 }), 1)
  assert.match(s.out.join('\n'), /STALE/)
  s.out.length = 0
  await main(['status', '--json'], s.io)
  assert.equal(JSON.parse(s.out.join('\n')).heartbeat.version, 1)
})

test('status --json exits 1 with no heartbeat or a stale one, 0 when fresh', async () => {
  const s = setup()
  assert.equal(await main(['status', '--json'], s.io), 1, 'no heartbeat')
  assert.equal(JSON.parse(s.out.join('\n')).heartbeat, null)
  const h = harness({ issues: [] })
  h.deps.heartbeat = (state) => writeHeartbeat(join(s.home, 'state.json'), state)
  await (await import('../src/tick.mjs')).tick(h.deps)
  const finished = Date.parse(/** @type {any} */ (readHeartbeat(join(s.home, 'state.json'))).tick.finishedAt)
  assert.equal(await main(['status', '--json'], { ...s.io, now: () => finished + 5000 }), 0)
  assert.equal(await main(['status', '--json'], { ...s.io, now: () => finished + 600_000 }), 1)
})

test('status creates neither the db nor the state dir when absent', async () => {
  const s = setup()
  const home = join(s.home, 'absent')
  writeFileSync(s.cfg, JSON.stringify({ repos: [{ slug: SLUG, path: '/repo' }], paths: { home } }))
  assert.equal(await main(['status'], s.io), 1)
  assert.equal(await main(['status', '--json'], s.io), 1)
  assert.equal(JSON.parse(s.out.at(-1) ?? '').mode, 'running')
  assert.equal(existsSync(home), false)
})

test('run task --issue N: claims, runs one worker in the foreground, transitions', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 5, labels: ['q:task'] }] })
  const start = h.spawner.start
  h.spawner.start = async (spec) => {
    assert.equal(spec.foreground, true)
    const started = await start(spec)
    h.gh.addPr({ number: 55, closes: [5] })
    return started
  }
  assert.equal(await main(['run', 'task', '--issue', '5'], { ...s.io, deps: () => h.deps }), 0)
  assert.equal(h.gh.marker(5)?.stage, 'submitted')
  assert.match(s.out.join('\n'), /o\/r#5: submitted · labels \(none\)/)

  assert.equal(await main(['run', 'task', '--issue', '5'], { ...s.io, deps: () => h.deps }), 1)
  assert.match(s.err.join('\n'), /not an open q:task issue/)
  assert.equal(await main(['run', 'task'], { ...s.io, deps: () => h.deps }), 1)
  assert.equal(await main(['run', 'task', '--issue', '5', '--repo', 'x/y'], { ...s.io, deps: () => h.deps }), 1)
})

test('run task --issue N on the graph engine: foreground worker, then the task graph ends at submit', async () => {
  const s = setup({ engine: 'graph' })
  const h = harness({ issues: [{ number: 5, labels: ['q:task'] }], config: { engine: 'graph' } })
  const start = h.spawner.start
  h.spawner.start = async (spec) => {
    assert.equal(spec.foreground, true)
    const started = await start(spec)
    h.gh.addPr({ number: 55, closes: [5] })
    return started
  }
  assert.equal(await main(['run', 'task', '--issue', '5'], { ...s.io, deps: () => h.deps }), 0)
  assert.equal(h.gh.marker(5)?.node, 'submit')
  assert.equal(h.deps.store.worker(SLUG, 5), null, 'the worker row is released')
  const text = s.out.join('\n')
  assert.match(text, /worker pid \d+ in /)
  assert.match(text, /worker exited 0/)
  assert.match(text, /o\/r#5: submit \(done\) · labels \(none\)/)

  // Again: the task graph is done; the PR is the pr graph's.
  assert.equal(await main(['run', 'task', '--issue', '5'], { ...s.io, deps: () => h.deps }), 1)
  assert.match(s.err.join('\n'), /nothing to run in the task graph; .*cambium run pr --issue 5/)
  assert.equal(h.spawner.started.length, 1)

  assert.equal(await main(['run', 'release', '--issue', '5'], { ...s.io, deps: () => h.deps }), 1)
  assert.match(s.err.join('\n'), /unknown graph "release"; known: task, pr, dispatch, release-prepare, release-promote/)
  // The release graphs take the repo; --issue is optional for them only.
  assert.equal(await main(['run', 'dispatch'], { ...s.io, deps: () => h.deps }), 1)
  assert.match(s.err.at(-1) ?? '', /usage: cambium run/)
})

test('run pr --issue N --follow polls every tickSeconds: merges the green PR, then closes out', async () => {
  const s = setup({ engine: 'graph' })
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
  assert.equal(await main(['run', 'task', '--issue', '6', '--follow'], { ...s.io, deps: () => h.deps }), 0)
  assert.equal(h.gh.marker(6)?.node, 'submit')
  /** @type {number[]} */
  const slept = []
  const sleep = async (/** @type {number} */ ms) => {
    slept.push(ms)
    if (slept.length === 1) h.gh.pr(66).checks = 'SUCCESS'
    if (slept.length === 2) h.gh.pr(66).state = 'MERGED'
  }
  assert.equal(await main(['run', 'pr', '--issue', '6', '--follow'], { ...s.io, sleep, deps: () => h.deps }), 0)
  assert.deepEqual(slept, [30_000, 30_000])
  assert.deepEqual(
    h.gh.calls.filter((c) => c.op === 'mergePull').map((c) => c.args),
    [[SLUG, 66]],
  )
  assert.equal(h.gh.issue(6).state, 'CLOSED')
  assert.equal(h.gh.marker(6)?.node, 'close-out')
  assert.match(s.out.join('\n'), /PR #66: not assessed \(CI PENDING, open\)/)
  assert.match(s.out.at(-1) ?? '', /o\/r#6: closed/)
})

test('the legacy engine runs only `run task`, without --follow', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 7, labels: ['q:task'] }] })
  assert.equal(await main(['run', 'task', '--issue', '7', '--follow'], { ...s.io, deps: () => h.deps }), 1)
  assert.equal(await main(['run', 'other', '--issue', '7'], { ...s.io, deps: () => h.deps }), 1)
  assert.match(s.err.join('\n'), /engine "legacy" runs only/)
  assert.equal(h.spawner.started.length, 0)
})

test('install --dry-run prints the plist; install writes it under LaunchAgents', async () => {
  const s = setup()
  assert.equal(await main(['install', '--dry-run'], s.io), 0)
  assert.match(s.out[0], /would write .*LaunchAgents\/com\.oakgreencc\.cambium\.plist/)
  assert.match(s.out[0], /<key>KeepAlive<\/key>/)
  assert.equal(await main(['install'], s.io), 0)
  const written = readFileSync(join(s.home, 'Library', 'LaunchAgents', 'com.oakgreencc.cambium.plist'), 'utf8')
  assert.match(written, new RegExp(s.cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(s.out.at(-1) ?? '', /launchctl bootstrap gui/)
})

test('start with no repos refuses; unknown verbs refuse; help', async () => {
  const s = setup({ repos: [] })
  assert.equal(await main(['start'], s.io), 1)
  assert.match(s.err[0], /no repos/)
  assert.equal(await main(['frobnicate'], s.io), 1)
  assert.equal(await main(['help'], s.io), 0)
  assert.match(s.out.at(-1) ?? '', /cambium run task --issue/)
  assert.match(s.out.at(-1) ?? '', /cambium run release-prepare \[--repo/)
  assert.match(s.out.at(-1) ?? '', /cambium run release-promote \[--repo <owner\/name>\] \[--issue <pr>\]/)
  assert.match(s.out.at(-1) ?? '', /run <task\|pr\|dispatch>/)
})

test('start --once: one tick through the injected deps, then out', async () => {
  const s = setup()
  const h = harness({ issues: [{ number: 3, labels: ['q:task'] }] })
  assert.equal(await main(['start', '--once'], { ...s.io, deps: () => h.deps }), 0)
  assert.equal(h.spawner.started.length, 1)
  assert.equal(h.beats.length, 1)
})

test('daemon loop: ticks until aborted, never waits on a worker, survives a throwing tick', async () => {
  const h = harness({ issues: [{ number: 1, labels: ['q:task'] }] })
  const ac = new AbortController()
  let waits = 0
  const n = await runDaemon(h.deps, {
    signal: ac.signal,
    wait: async () => {
      if (++waits === 2)
        h.deps.store.workers = () => {
          throw new Error('db gone')
        }
      if (waits === 3) ac.abort()
    },
  })
  assert.equal(n, 3)
  assert.ok(h.events.some((e) => /db gone/.test(e.msg)))
})

/**
 * `cambium start` against a real config file, ticking with no wait; `between(tick)` runs after each tick's
 * heartbeat (edit the file there), and the daemon stops after `ticks`.
 * @param {any} seed @param {any} extra @param {number} ticks @param {(tick: number, s: ReturnType<typeof setup>) => void} between
 */
async function startWithEdits(seed, extra, ticks, between) {
  const s = setup({ tickSeconds: 0, ...extra })
  const h = harness(seed)
  const ac = new AbortController()
  const beat = h.deps.heartbeat
  let n = 0
  h.deps.heartbeat = (state) => {
    beat(state)
    between(++n, s)
    if (n === ticks) ac.abort()
  }
  const deps = (/** @type {any} */ config) => Object.assign(h.deps, { config })
  assert.equal(await main(['start'], { ...s.io, signal: ac.signal, deps }), 0)
  return { h, s }
}

/** @param {ReturnType<typeof setup>} s @param {any} extra */
const rewrite = (s, extra) =>
  writeFileSync(
    s.cfg,
    JSON.stringify({
      cambium: {
        host: 'mac',
        repos: [{ slug: SLUG, path: '/repo' }],
        paths: { home: s.home },
        tickSeconds: 0,
        ...extra,
      },
    }),
  )

test('config reload: a cap raised in the file applies from the next tick, without a restart', async () => {
  const { h } = await startWithEdits(
    { issues: [{ number: 1, labels: ['q:task'] }] },
    { phases: { task: { cap: 0 } } },
    2,
    (tick, s) => tick === 1 && rewrite(s, { phases: { task: { cap: 1 } } }),
  )
  assert.deepEqual(
    h.spawner.started.map((w) => w.issue),
    [1],
  )
  assert.equal(h.deps.config.phases.task.cap, 1)
  assert.ok(h.events.some((e) => e.level === 'info' && /config reloaded: phases/.test(e.msg)))
})

test('config reload: a broken file keeps the running config and warns once; fixing it applies', async () => {
  const { h } = await startWithEdits({}, { phases: { task: { cap: 1 } } }, 5, (tick, s) => {
    if (tick === 1) writeFileSync(s.cfg, '{ "repos": [')
    if (tick === 3) writeFileSync(s.cfg, '{}')
    if (tick === 4) rewrite(s, { phases: { task: { cap: 2 } } })
  })
  const warns = h.events.filter((e) => e.level === 'warn').map((e) => e.msg)
  assert.equal(warns.length, 2, `one warning per distinct problem, not per tick: ${warns.join(' | ')}`)
  assert.match(warns[0], /config not reloaded, keeping the running one: .*forest\.json/)
  assert.match(warns[1], /config not reloaded, keeping the running one: no repos/)
  assert.equal(h.deps.config.phases.task.cap, 2)
})

test('config reload: a restart-only key is not applied, and says so once', async () => {
  const { h } = await startWithEdits(
    {},
    {},
    3,
    (tick, s) => tick === 1 && rewrite(s, { host: 'other', engine: 'graph' }),
  )
  assert.equal(h.deps.config.host, 'mac')
  assert.equal(h.deps.config.engine, 'legacy')
  const warns = h.events.filter((e) => e.level === 'warn').map((e) => e.msg)
  assert.deepEqual(warns, ['config: host, engine changed; restart cambium to apply'])
})

test('one daemon per database; a dead holder does not block', () => {
  const store = openStore(':memory:')
  const procs = { alive: (/** @type {number} */ pid) => pid === 1, kill() {} }
  acquireLock(store, procs, 1)
  assert.throws(() => acquireLock(store, procs, 2), /pid 1/)
  const dead = { alive: () => false, kill() {} }
  acquireLock(store, dead, 2)
  assert.equal(store.get('daemon.pid'), '2')
})

test('logger: file rotation and the event ring', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cambium-')), 'logs', 'cambium.log')
  /** @type {string[]} */
  const echoed = []
  const { log, events } = makeLogger({ file, maxBytes: 10, keep: 2, now: () => 0, echo: (l) => echoed.push(l) })
  log('info', 'one', { repo: 'o/r', issue: 1 })
  log('warn', 'two')
  log('error', 'three')
  assert.deepEqual(
    events().map((e) => e.msg),
    ['two', 'three'],
  )
  assert.match(echoed[0], /info {2}o\/r#1 one/)
  assert.match(readFileSync(`${file}.1`, 'utf8'), /two/)
  assert.match(readFileSync(file, 'utf8'), /three/)
})

test('logger: an entry is one line, an HTML error page shrinks to its title, a long message is cut', () => {
  /** @type {string[]} */
  const echoed = []
  const { log, events } = makeLogger({ now: () => 0, echo: (l) => echoed.push(l) })
  const page = `<!DOCTYPE html>\n<html>\n<head><title>Unicorn! &middot; GitHub</title></head>\n<body>\n<img src="data:image/png;base64,${'A'.repeat(5000)}">\n</body>\n</html>`
  log('error', `read: graft graphql exited 1: graft graphql: https://api.github.com/graphql: 504 ${page}`, {
    repo: 'o/r',
  })
  log('error', `502 <html>\n<head><title>502 Bad Gateway</title></head>\n<body>nginx</body>\n</html>`)
  log('warn', 'x'.repeat(LOG_MSG_MAX + 50))
  assert.equal(echoed[0].split('\n').length, 1)
  assert.match(echoed[0], /graphql: 504 \(HTML page: Unicorn! &middot; GitHub\)$/)
  assert.equal(events()[1].msg, '502 (HTML page: 502 Bad Gateway)')
  assert.equal(events()[2].msg.length, LOG_MSG_MAX + 1)
  assert.equal(oneLine('refusing:\n  a human merges it'), 'refusing: a human merges it')
})
