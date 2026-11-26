// @ts-check
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { resolveSettings } from '../src/config.mjs'
import { cachedIssues, cachedQueues } from '../src/github.mjs'
import { emptyColumns, group } from '../src/queues.mjs'
import { briefOf, buildState, createApp, decideCommandOf, hostnameOf, shellWord } from '../src/server.mjs'
import { graphqlAnswer, heartbeat, T0 } from './fixtures.mjs'

const REPO = 'oakgreencc/monorepo'

function stateFile(/** @type {any} */ body) {
  const path = join(mkdtempSync(join(tmpdir(), 'canopy-')), 'state.json')
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

const fakeQueues = (now = () => T0) => {
  const seen = /** @type {string[][]} */ ([])
  const client = {
    queues: async (/** @type {string} */ slug) => {
      seen.push([slug])
      return group(graphqlAnswer(), slug)
    },
  }
  return { queues: cachedQueues({ client, now }), seen }
}

/**
 * Serve once on an ephemeral loopback port, run `fn`, then close every socket
 * so no handle outlives the test.
 *
 * @param {import('../src/server.mjs').AppOptions} opts
 * @param {(get: (path: string, init?: { method?: string, host?: string }) => Promise<{ status: number, type: string, body: string }>) => Promise<void>} fn
 */
async function serve(opts, fn) {
  const server = createApp(opts)
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  const get = (/** @type {string} */ path, { method = 'GET', host = `127.0.0.1:${port}` } = {}) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host, connection: 'close' } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }))
      })
      req.on('error', reject)
      req.end()
    })
  try {
    await fn(/** @type {any} */ (get))
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(() => r(undefined)))
  }
}

test('GET / serves one self-contained page', async () => {
  const { queues } = fakeQueues()
  await serve({ statePath: stateFile(heartbeat()), repos: [REPO], queues }, async (get) => {
    const res = await get('/')
    assert.equal(res.status, 200)
    assert.match(res.type, /text\/html/)
    assert.match(res.body, /<style>/)
    assert.match(res.body, /<script>/)
    assert.match(res.body, /\/api\/state/)
    assert.match(res.body, /prefers-color-scheme:dark/)
    assert.doesNotMatch(res.body, /<(script|link)[^>]+(src|href)=/)
    assert.doesNotMatch(res.body, /https?:\/\/(?!github\.com)[a-z]/i)
    const script = res.body.split('<script>')[1].split('</script>')[0]
    assert.doesNotThrow(() => new Function(script))
    assert.match(res.body, /id="tab-graphs" data-tab="graphs"/)
    assert.match(res.body, /function layoutGraph/)
  })
})

test('GET /api/state: heartbeat and grouped queues', async () => {
  const { queues } = fakeQueues(() => Date.now())
  const hb = heartbeat({ tick: { n: 1, finishedAt: new Date().toISOString() } })
  await serve({ statePath: stateFile(hb), repos: [REPO], queues }, async (get) => {
    const res = await get('/api/state')
    assert.equal(res.status, 200)
    assert.match(res.type, /application\/json/)
    const s = JSON.parse(res.body)
    assert.equal(s.heartbeat.status, 'ok')
    assert.equal(s.heartbeat.stale, false)
    assert.equal(s.heartbeat.data.workers[0].issue, 12)
    assert.equal(s.github.columns.human[0].why, 'budget')
    assert.deepEqual(
      s.github.prs.map((/** @type {any} */ p) => p.number),
      [20, 22],
    )
    assert.deepEqual(
      s.github.stranded.map((/** @type {any} */ i) => [i.number, i.pr.number]),
      [[7, 30]],
    )
    assert.equal(s.cacheMs, 60_000)
  })
})

test('GET /api/state with an unknown version still answers 200 with the message', async () => {
  const { queues } = fakeQueues()
  await serve({ statePath: stateFile(heartbeat({ version: 9 })), repos: [REPO], queues }, async (get) => {
    const s = JSON.parse((await get('/api/state')).body)
    assert.equal(s.heartbeat.status, 'unknown-version')
    assert.equal(s.github.columns.task.length, 1)
  })
})

test('repos default to the heartbeat when none are configured; none at all is a note', async () => {
  const { queues, seen } = fakeQueues()
  const s = await buildState({ statePath: stateFile(heartbeat()), repos: [], queues, now: () => T0 })
  assert.deepEqual(seen, [[REPO]])
  assert.equal(s.github.columns.task.length, 1)

  const none = await buildState({ statePath: '/nonexistent/state.json', repos: [], queues, now: () => T0 })
  assert.equal(none.heartbeat.status, 'missing')
  assert.match(none.notes.join(), /no repositories/)
})

test('read-only, loopback Host only, 404 elsewhere', async () => {
  const { queues } = fakeQueues()
  await serve({ statePath: stateFile(heartbeat()), repos: [REPO], queues }, async (get) => {
    assert.equal((await get('/api/state', { method: 'POST' })).status, 405)
    assert.equal((await get('/nope')).status, 404)
    assert.equal((await get('/', { host: 'evil.example' })).status, 403)
    assert.equal((await get('/', { host: 'localhost:4317' })).status, 200)
    assert.equal((await get('/', { method: 'HEAD' })).body, '')
  })
})

test('GET /api/issue/<owner>/<name>/<n>: watched repos only, 404 for a missing issue', async () => {
  const { queues } = fakeQueues()
  const issues = cachedIssues({
    client: {
      queues: async () => assert.fail('not used'),
      issue: async (slug, n) => (n === 4 ? /** @type {any} */ ({ repo: slug, number: n, title: 'Issue 4' }) : null),
    },
  })
  await serve({ statePath: stateFile(heartbeat()), repos: [REPO], queues, issues }, async (get) => {
    const ok = await get(`/api/issue/${REPO}/4`)
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).issue.title, 'Issue 4')
    assert.equal((await get(`/api/issue/${REPO}/5`)).status, 404)
    assert.match(JSON.parse((await get('/api/issue/someone/else/4')).body).error, /watched repo/)
    assert.equal((await get(`/api/issue/${REPO}/0`)).status, 404)
  })
})

test('hostnameOf strips port and brackets', () => {
  assert.equal(hostnameOf('127.0.0.1:4317'), '127.0.0.1')
  assert.equal(hostnameOf('[::1]:4317'), '::1')
  assert.equal(hostnameOf('LocalHost'), 'localhost')
  assert.equal(hostnameOf(undefined), '')
})

test('resolveSettings: --state, then canopy.state, then cambium paths.heartbeat, then paths.home, then ~/.oakgreen/cambium', () => {
  const files = /** @type {Record<string, string>} */ ({
    '/c/hb.json': JSON.stringify({ cambium: { paths: { heartbeat: '~/x/state.json' }, repos: [{ slug: REPO }] } }),
    '/c/home.json': JSON.stringify({ cambium: { paths: { home: '/srv/cambium' } } }),
    '/c/own.json': JSON.stringify({
      canopy: { state: '/own/state.json', repos: ['c/d'] },
      cambium: { paths: { heartbeat: '/hb.json' }, repos: [{ slug: REPO }] },
    }),
  })
  const read = (/** @type {string} */ p) => {
    if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return files[p]
  }
  const deps = { home: '/home/me', read, env: {} }
  assert.equal(resolveSettings({ state: '/s.json', config: '/c/hb.json' }, deps).statePath, '/s.json')
  const fromCfg = resolveSettings({}, { ...deps, env: { OAKGREEN_FOREST_CONFIG_PATH: '/c/hb.json' } })
  assert.equal(fromCfg.statePath, '/home/me/x/state.json')
  assert.deepEqual(fromCfg.repos, [REPO])
  assert.equal(resolveSettings({ config: '/c/home.json' }, deps).statePath, '/srv/cambium/state.json')
  const own = resolveSettings({ config: '/c/own.json' }, deps)
  assert.equal(own.statePath, '/own/state.json', "canopy's own section beats cambium's")
  assert.deepEqual(own.repos, ['c/d'])
  assert.equal(resolveSettings({ state: '/s.json', config: '/c/own.json' }, deps).statePath, '/s.json')
  const dflt = resolveSettings({}, deps)
  assert.equal(dflt.statePath, '/home/me/.oakgreen/cambium/state.json')
  assert.equal(dflt.configPath, '/home/me/.oakgreen/forest.json')
  assert.equal(dflt.configError, null)
  assert.match(String(resolveSettings({ config: '/c/missing.json' }, deps).configError), /not found/)
  assert.deepEqual(resolveSettings({ repos: ['a/b', 'a/b'] }, deps).repos, ['a/b'])
  assert.throws(() => resolveSettings({ repos: ['nope'] }, deps), /owner\/name/)
})

test('cli: defaults to 127.0.0.1:4317, honours --port/--host, rejects bad flags', () => {
  const client = { queues: async () => group(graphqlAnswer(), REPO) }
  const quiet = { env: { HOME: '/nonexistent-home' }, client, out: () => {}, err: () => {} }
  const d = main(['--config', '/nonexistent/c.json'], quiet)
  assert.ok(typeof d === 'object')
  assert.deepEqual([d.host, d.port], ['127.0.0.1', 4317])
  const c = main(['--config', '/nonexistent/c.json', '--port', '0', '--host', '::1', '--repo', REPO], quiet)
  assert.ok(typeof c === 'object')
  assert.deepEqual([c.host, c.port], ['::1', 0])
  assert.equal(main(['--port', 'x'], quiet), 2)
  assert.equal(main(['--bogus'], quiet), 2)
  assert.equal(main(['--repo', 'bad'], quiet), 2)
  assert.equal(main(['--help'], quiet), 0)
})

test('session briefs: a q:human item with a brief carries the copy command; one without does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-briefs-'))
  mkdirSync(join(dir, 'oakgreencc__monorepo'))
  writeFileSync(join(dir, 'oakgreencc__monorepo', 'issue-4.md'), '# brief')
  const item = (/** @type {number} */ number, /** @type {string} */ why) => ({
    repo: REPO,
    number,
    title: `#${number}`,
    url: '',
    createdAt: null,
    updatedAt: null,
    labels: ['q:human', `why:${why}`],
    why,
    priority: null,
  })
  const answer = {
    repos: [],
    columns: { ...emptyColumns(), human: [item(4, 'budget'), item(5, 'triage')] },
    prs: [],
    stranded: [],
    fetchedAt: null,
    cached: false,
  }
  const queues = { get: async () => answer }
  const briefs = { dir, paths: { [REPO]: '/src/my repo' } }
  const s = await buildState({ statePath: stateFile(heartbeat()), repos: [REPO], queues, now: () => T0, briefs })
  const [withBrief, without] = s.github.columns.human
  assert.equal(withBrief.brief.path, join(dir, 'oakgreencc__monorepo', 'issue-4.md'))
  assert.equal(withBrief.brief.command, `cd '/src/my repo' && claude "$(cat ${withBrief.brief.path})"`)
  assert.equal(without.brief, undefined)
  assert.equal(/** @type {any} */ (answer.columns.human[0]).brief, undefined, 'the cached answer is not touched')

  assert.equal(
    briefOf({ dir, paths: {} }, { repo: REPO, number: 4 })?.command,
    `claude "$(cat ${withBrief.brief.path})"`,
  )
  assert.equal(shellWord("it's"), `'it'\\''s'`)
})

test('the page renders the copy command only from an item with a brief', async () => {
  const { PAGE } = await import('../src/page.mjs')
  assert.match(PAGE, /if \(sel && sel\.brief\) parts\.push\(sessionPart\(sel\.brief\)\)/)
  assert.match(PAGE, /'data-copy': b\.command/)
})

test('resolveSettings: briefs live under the cambium home; repo paths come from its config', () => {
  const cfg = JSON.stringify({
    cambium: { paths: { home: '~/cam' }, repos: [{ slug: REPO, path: '~/src/mono' }, { slug: 'a/b' }] },
  })
  const s = resolveSettings({ config: '/c.json' }, { env: {}, home: '/h', read: () => cfg })
  assert.equal(s.briefs.dir, '/h/cam/briefs')
  assert.deepEqual(s.briefs.paths, { [REPO]: '/h/src/mono' })
})

test('the health tab renders each repo: watched workflows, budget and a paused read', async () => {
  const { PAGE } = await import('../src/page.mjs')
  assert.match(PAGE, /body\.push\(summary\(d\), repos\(d, now\)/)
  assert.match(PAGE, /const WATCH = \{ green: \['ok', 'green'\], red: \['err', 'red'\], unknown: \['', 'unknown'\] \}/)
  assert.match(PAGE, /if \(r\.pausedUntil\) out\.push\(h\('div', \{ class: 'banner' \}/)
})

test('decide items: an ask:decide q:human item carries the /oakgreen:decide command; any other does not', async () => {
  const item = (/** @type {number} */ number, /** @type {string[]} */ labels, extra = {}) => ({
    repo: REPO,
    number,
    title: `#${number}`,
    url: '',
    createdAt: null,
    updatedAt: null,
    labels: ['q:human', ...labels],
    why: null,
    priority: null,
    ...extra,
  })
  const answer = {
    repos: [],
    columns: { ...emptyColumns(), human: [item(4, ['ask:decide', 'ask:session']), item(5, ['why:triage'])] },
    prs: [],
    stranded: [],
    fetchedAt: null,
    cached: false,
  }
  const queues = { get: async () => answer }
  const briefs = { dir: join(tmpdir(), 'canopy-no-briefs'), paths: { [REPO]: '/src/my repo' } }
  const s = await buildState({ statePath: stateFile(heartbeat()), repos: [REPO], queues, now: () => T0, briefs })
  const [decide, other] = s.github.columns.human
  assert.equal(decide.decideCommand, `cd '/src/my repo' && claude "/oakgreen:decide ${REPO}#4"`)
  assert.equal('decideCommand' in other, false, 'an item with no decision gets no command')
  assert.equal('brief' in other, false)
  assert.equal(decideCommandOf({}, { repo: REPO, number: 4 }), `claude "/oakgreen:decide ${REPO}#4"`)
  const noBriefs = await buildState({ statePath: stateFile(heartbeat()), repos: [REPO], queues, now: () => T0 })
  assert.equal(noBriefs.github.columns.human[0].decideCommand, `claude "/oakgreen:decide ${REPO}#4"`)
})

test('the page renders the decide part only from an item with a decide command', async () => {
  const { PAGE } = await import('../src/page.mjs')
  assert.match(PAGE, /if \(sel && sel\.decideCommand\) parts\.push\(decidePart\(sel, h, link\)\)/)
  assert.match(PAGE, /function decidePart\(/)
})
