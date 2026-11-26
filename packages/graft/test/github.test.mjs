// @ts-check
/**
 * The GitHub port: the client's own behaviour (paging, absence, bytes), and
 * `graft pr merge` end to end — the real verb, the real client, a bare repo
 * standing in for GitHub (fixtures.mjs). Until the fake could answer every
 * call the verb makes, none of its orchestration could run in a test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { explain } from '../src/cli/explain.mjs'
import { run as pr } from '../src/cli/pr.mjs'
import { PublishError } from '../src/errors.mjs'
import {
  createClient,
  droppedConnection,
  ERROR_BODY_MAX,
  errorBody,
  isNotFound,
  retryServerErrors,
  SERVER_ERROR_RETRIES,
  serverErrorWait,
} from '../src/github/app.mjs'
import { clientOver, commitOn, run, scenario } from './fixtures.mjs'

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** A fetch serving `pages[url]` = [status, body, link?]. */
const pagedFetch = (pages) =>
  /** @type {typeof globalThis.fetch} */ (
    async (url) => {
      const [status, body, link] = pages[String(url)] ?? [404, '{"message":"Not Found"}']
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: link ? { link: `<${link}>; rel="next"` } : {},
      })
    }
  )
const API = 'https://api.github.com'

test('paginate: array pages concatenated by Link: rel="next"', async () => {
  const client = createClient({
    token: 't',
    fetch: pagedFetch({ [`${API}/l`]: [200, [1, 2], `${API}/l?page=2`], [`${API}/l?page=2`]: [200, [3]] }),
  })
  assert.deepEqual(await client.paginate('/l'), [1, 2, 3])
})

test('paginate: a wrapped list is concatenated on its one array key; a non-list comes back as is', async () => {
  const client = createClient({
    token: 't',
    fetch: pagedFetch({
      [`${API}/w`]: [200, { total_count: 3, jobs: [{ id: 1 }] }, `${API}/w?page=2`],
      [`${API}/w?page=2`]: [200, { total_count: 3, jobs: [{ id: 2 }, { id: 3 }] }],
      [`${API}/one`]: [200, { id: 9 }],
    }),
  })
  assert.deepEqual(await client.paginate('/w'), { total_count: 3, jobs: [{ id: 1 }, { id: 2 }, { id: 3 }] })
  assert.deepEqual(await client.paginate('/one'), { id: 9 })
})

test('getOrNull: 404 is null; any other refusal still throws, with its status', async () => {
  const client = createClient({
    token: 't',
    fetch: pagedFetch({
      [`${API}/gone`]: [404, '{}'],
      [`${API}/no`]: [403, '{"message":"nope"}'],
      [`${API}/ok`]: [200, { a: 1 }],
    }),
  })
  assert.equal(await client.getOrNull('/gone'), null)
  assert.deepEqual(await client.getOrNull('/ok'), { a: 1 })
  await assert.rejects(client.getOrNull('/no'), (err) => /** @type {any} */ (err).status === 403)
})

test('download: the body as bytes, authenticated; a refusal carries its status', async () => {
  /** @type {any} */
  let seen = null
  const client = createClient({
    token: 'tok',
    fetch: /** @type {any} */ (
      async (url, init) => {
        seen = init
        return String(url).endsWith('/zip')
          ? new Response(new Uint8Array([0, 1, 255]))
          : new Response('no', { status: 410 })
      }
    ),
  })
  assert.deepEqual([...(await client.download('/zip'))], [0, 1, 255])
  assert.equal(seen.headers.Authorization, 'token tok')
  await assert.rejects(client.download('/gone'), (err) => /** @type {any} */ (err).status === 410)
})

test('explain blames the App credentials only for a missing credential file', () => {
  const enoent = (/** @type {string} */ path) => new Error(`ENOENT: no such file or directory, open '${path}'`)
  const env = { GRAFT_HOME: '/home/a/.oakgreen/graft' }
  const apps = join(env.GRAFT_HOME, 'apps', 'my-app')
  assert.equal(explain(enoent('.claude/scratch/body.md'), env), null)
  assert.equal(explain(enoent('/tmp/private-key.pem'), env), null) // the name alone is not enough
  assert.match(String(explain(enoent(join(apps, 'private-key.pem')), env)), /Missing App credentials/)
  assert.match(String(explain(enoent(join(apps, 'app.json')), env)), /Missing App credentials/)
  const custom = '/keys/elsewhere.pem'
  assert.equal(explain(enoent(custom), env), null)
  assert.match(String(explain(enoent(custom), { ...env, GRAFT_PRIVATE_KEY_PATH: custom })), /Missing App credentials/)
  // A real fs error carries the path on `err.path`; that wins over the message.
  const real = Object.assign(enoent('ignored'), { code: 'ENOENT', path: join(apps, 'app.json') })
  assert.match(String(explain(real, env)), /Missing App credentials/)
  const body = Object.assign(enoent(join(apps, 'app.json')), { code: 'ENOENT', path: 'missing.md' })
  assert.equal(explain(body, env), null)
})

// --- serverErrorWait: a 5xx on a content-addressed write is worth repeating ----------

const failed = (status) => Object.assign(new Error(`/x: ${status} {"message":"Server Error"}`), { status })

test('serverErrorWait: 500/502/503/504 wait a second, doubling on every further attempt', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(serverErrorWait(failed(status), 0), 1_000)
    assert.equal(serverErrorWait(failed(status), 1), 2_000)
    assert.equal(serverErrorWait(failed(status), 3), 8_000)
  }
})

test('serverErrorWait: anything else is not a server error', () => {
  for (const status of [400, 403, 404, 422, 429, 501, 505]) {
    assert.equal(serverErrorWait(failed(status), 0), null)
  }
  // A status only in the message is not trusted: the client sets `status`.
  assert.equal(serverErrorWait(new Error('/x: 502 boom'), 0), null)
  assert.equal(serverErrorWait(new TypeError('fetch failed'), 0), null)
})

/** A `fetch failed` whose connection dropped, as undici throws it. */
const dropped = (code) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code }) })

test('serverErrorWait: a dropped connection (stale keep-alive socket) waits like a 5xx', () => {
  for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE']) {
    assert.equal(droppedConnection(dropped(code)), code)
    assert.equal(serverErrorWait(dropped(code), 0), 1_000)
    assert.equal(serverErrorWait(dropped(code), 2), 4_000)
  }
  assert.equal(serverErrorWait(dropped('ENOTFOUND'), 0), null)
  assert.equal(serverErrorWait(dropped(undefined), 0), null)
})

test('the client never retries a write whose connection dropped', async () => {
  let calls = 0
  const fetch = /** @type {typeof globalThis.fetch} */ (
    async () => {
      calls++
      throw dropped('UND_ERR_SOCKET')
    }
  )
  const client = createClient({ token: 'ghs_t', fetch, sleep: async () => assert.fail('slept') })
  await assert.rejects(
    client.json('/repos/o/r/git/commits', 'POST', {}),
    (err) => droppedConnection(err) === 'UND_ERR_SOCKET',
  )
  assert.equal(calls, 1)
})

test('the client repeats a read whose connection dropped, and says so', async () => {
  let calls = 0
  /** @type {string[]} */
  const reports = []
  /** @type {number[]} */
  const waits = []
  const fetch = /** @type {typeof globalThis.fetch} */ (
    async () => {
      if (++calls === 1) throw dropped('UND_ERR_SOCKET')
      return new Response(JSON.stringify({ sha: 'abc', tree: { sha: 'def' } }))
    }
  )
  const client = createClient({
    token: 'ghs_t',
    fetch,
    sleep: async (ms) => void waits.push(ms),
    report: (line) => reports.push(line),
  })
  assert.deepEqual(await client.getOrNull('/repos/o/r/git/commits/abc'), { sha: 'abc', tree: { sha: 'def' } })
  assert.equal(calls, 2)
  assert.deepEqual(waits, [1_000])
  assert.match(reports[0], /connection dropped \(UND_ERR_SOCKET\) on GET \/repos\/o\/r\/git\/commits\/abc/)
})

test('a request that never got an answer names its method, path and cause code', async () => {
  let calls = 0
  const fetch = /** @type {typeof globalThis.fetch} */ (
    async () => {
      calls++
      throw dropped('ECONNRESET')
    }
  )
  const client = createClient({ token: 'ghs_t', fetch, sleep: async () => {} })
  await assert.rejects(client.api('/repos/o/r/git/commits/abc'), (err) => {
    assert.match(
      String(/** @type {Error} */ (err).message),
      /^GET \/repos\/o\/r\/git\/commits\/abc: fetch failed \(ECONNRESET/,
    )
    assert.equal(droppedConnection(err), 'ECONNRESET')
    return true
  })
  assert.equal(calls, 1 + SERVER_ERROR_RETRIES)
  await assert.rejects(
    client.json('/repos/o/r/git/commits', 'POST', {}),
    /^Error: POST \/repos\/o\/r\/git\/commits: fetch failed \(ECONNRESET: other side closed\)/,
  )
})

test('retryServerErrors repeats a dropped connection and says so', async () => {
  let calls = 0
  /** @type {string[]} */
  const reports = []
  const out = await retryServerErrors(
    'POST /repos/o/r/git/trees',
    async () => {
      if (++calls === 1) throw dropped('EPIPE')
      return { sha: 'abc' }
    },
    { sleep: async () => {}, report: (line) => reports.push(line) },
  )
  assert.deepEqual(out, { sha: 'abc' })
  assert.equal(calls, 2)
  assert.deepEqual(reports, [
    `connection dropped (EPIPE) on POST /repos/o/r/git/trees: waiting 1s (retry 1/${SERVER_ERROR_RETRIES})`,
  ])
})

test('errorBody: JSON kept on one line, an HTML page becomes its title, other text cut to one line', () => {
  assert.equal(errorBody('{\n  "message": "Not Found"\n}'), '{ "message": "Not Found" }')
  assert.equal(
    errorBody('<html>\n<head><title>502 Bad Gateway</title></head>\n<body><center>nginx</center></body>\n</html>'),
    '(HTML page: 502 Bad Gateway)',
  )
  assert.equal(errorBody('<!DOCTYPE html>\n<html><body>no title</body></html>'), '(HTML page)')
  const long = errorBody(`line one\nline two ${'x'.repeat(ERROR_BODY_MAX)}`)
  assert.equal(long.length, ERROR_BODY_MAX + 1)
  assert.ok(long.startsWith('line one line two'))
  assert.equal(errorBody(''), '')
})

test('a 504 HTML page from GitHub’s edge is thrown as one line naming its title', async () => {
  const page = '<!DOCTYPE html>\n<html>\n<head><title>Unicorn! · GitHub</title></head>\n<body>…</body>\n</html>'
  const fetch = /** @type {typeof globalThis.fetch} */ (async () => new Response(page, { status: 504 }))
  const client = createClient({ token: 'ghs_t', fetch, sleep: async () => {} })
  await assert.rejects(client.json('/repos/o/r', 'GET'), (err) => {
    assert.equal(/** @type {Error} */ (err).message, '/repos/o/r: 504 (HTML page: Unicorn! · GitHub)')
    return true
  })
})

test('the client itself never retries a 5xx — that is the caller’s call, per endpoint', async () => {
  let calls = 0
  const fetch = /** @type {typeof globalThis.fetch} */ (
    async () => {
      calls++
      return new Response('{"message":"Server Error"}', { status: 502 })
    }
  )
  const client = createClient({ token: 'ghs_t', fetch, sleep: async () => assert.fail('slept') })
  await assert.rejects(client.json('/repos/o/r/git/commits', 'POST', {}), /: 502 /)
  assert.equal(calls, 1)
})

test('retryServerErrors repeats a 5xx with doubling waits, reporting each, and returns the answer', async () => {
  let calls = 0
  /** @type {number[]} */
  const waits = []
  /** @type {string[]} */
  const reports = []
  const out = await retryServerErrors(
    'POST /repos/o/r/git/trees',
    async () => {
      if (++calls < 3) throw failed(calls === 1 ? 502 : 503)
      return { sha: 'abc' }
    },
    { sleep: async (ms) => void waits.push(ms), report: (line) => reports.push(line) },
  )
  assert.deepEqual(out, { sha: 'abc' })
  assert.equal(calls, 3)
  assert.deepEqual(waits, [1_000, 2_000])
  assert.deepEqual(reports, [
    `server error (502) on POST /repos/o/r/git/trees: waiting 1s (retry 1/${SERVER_ERROR_RETRIES})`,
    `server error (503) on POST /repos/o/r/git/trees: waiting 2s (retry 2/${SERVER_ERROR_RETRIES})`,
  ])
})

test('retryServerErrors gives up after SERVER_ERROR_RETRIES and never retries a non-5xx', async () => {
  let calls = 0
  /** @type {number[]} */
  const waits = []
  await assert.rejects(
    retryServerErrors(
      'POST /t',
      async () => {
        calls++
        throw failed(502)
      },
      { sleep: async (ms) => void waits.push(ms) },
    ),
    /: 502 /,
  )
  assert.equal(calls, SERVER_ERROR_RETRIES + 1)
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000].slice(0, SERVER_ERROR_RETRIES))

  calls = 0
  await assert.rejects(
    retryServerErrors(
      'POST /t',
      async () => {
        calls++
        throw failed(422)
      },
      { sleep: async () => assert.fail('slept') },
    ),
    /: 422 /,
  )
  assert.equal(calls, 1)
})

test('isNotFound and explain read the status the client attaches', () => {
  const notFound = Object.assign(new Error('boom'), { status: 404 })
  assert.equal(isNotFound(notFound), true)
  assert.equal(isNotFound(new Error('/x: 404 {}')), true)
  assert.equal(isNotFound(Object.assign(new Error('/x: 403'), { status: 403 })), false)
  assert.match(String(explain(notFound)), /Not found — or the App is not installed/)
})

// ---------------------------------------------------------------------------
// `graft pr merge`, end to end
// ---------------------------------------------------------------------------

/**
 * develop on the fake GitHub carries `base` files; agent/x adds `pr` files on
 * top; PR #7 is agent/x → develop. The worktree is a clone of it.
 */
function prScenario({ base = {}, head = { 'src/feature.ts': 'export {}\n' } } = {}) {
  const s = scenario()
  if (Object.keys(base).length) commitOn(s.bare, 'develop', base, { message: 'base policy' })
  commitOn(s.bare, 'agent/x', head, { from: 'develop', message: 'the PR' })
  s.client.openPull(7, 'agent/x', 'develop')
  const merge = (...flags) => pr(['merge', '7', '-C', s.wt, '--repo', 'o/r', ...flags], { client: s.client })
  const merged = () => s.client.calls.some((c) => c.method === 'PUT' && c.path === '/repos/o/r/pulls/7/merge')
  return { ...s, merge, merged }
}

const CODEOWNERS = { CODEOWNERS: '/ci/ @alice\n' }

test('pr merge: a clean PR into the base merges, pinned to the head it judged', async () => {
  const s = prScenario({ base: CODEOWNERS })
  try {
    await s.merge()
    assert.equal(s.merged(), true)
    const put = s.client.calls.find((c) => c.method === 'PUT')
    assert.equal(put?.body.sha, run(s.bare, ['rev-parse', 'refs/heads/agent/x']).trim())
  } finally {
    s.cleanup()
  }
})

test('pr merge: a PR touching a path the BASE protects is refused, and nothing is merged', async () => {
  const s = prScenario({ base: CODEOWNERS, head: { 'ci/gate.mjs': 'weakened\n' } })
  try {
    await assert.rejects(
      s.merge(),
      (err) => err instanceof PublishError && /ci\/gate\.mjs — owned by @alice in CODEOWNERS/.test(err.message),
    )
    assert.equal(s.merged(), false)
  } finally {
    s.cleanup()
  }
})

test('pr merge: the base is red — refused; a PR that contains the base head and is green goes through', async () => {
  const s = prScenario({ base: { '.graft.json': JSON.stringify({ requiredCheck: 'ci' }) } })
  try {
    s.client.setCheck('develop', 'failure')
    await assert.rejects(s.merge(), (err) => err instanceof PublishError && /`develop` is red/.test(err.message))
    assert.equal(s.merged(), false)

    // The PR carries develop's head (it was cut from it) and is green: the fix.
    s.client.setCheck(run(s.bare, ['rev-parse', 'refs/heads/agent/x']).trim(), 'success')
    await s.merge()
    assert.equal(s.merged(), true)
  } finally {
    s.cleanup()
  }
})

test("pr merge: the worktree's own .graft.json does not leak into the base's policy", async () => {
  // The base has no .graft.json, so no required check; the worktree's claims
  // one, and a mergeableBases that would refuse develop. Neither applies.
  const s = prScenario()
  try {
    writeFileSync(join(s.wt, '.graft.json'), JSON.stringify({ requiredCheck: 'ci', mergeableBases: ['main'] }))
    s.client.setCheck('develop', 'failure')
    await s.merge()
    assert.equal(s.merged(), true)
  } finally {
    s.cleanup()
  }
})

test('pr merge: a merge grant for this session lifts a liftable refusal, and says so', async (t) => {
  const s = prScenario({ base: CODEOWNERS, head: { 'ci/gate.mjs': 'reviewed change\n' } })
  const before = process.env.GRAFT_SESSION
  t.after(() => {
    if (before === undefined) delete process.env.GRAFT_SESSION
    else process.env.GRAFT_SESSION = before
  })
  try {
    process.env.GRAFT_SESSION = 'the-session'
    delete process.env.CLAUDE_CODE_SESSION_ID
    mkdirSync(join(s.wt, '.git', 'graft'), { recursive: true })
    writeFileSync(
      join(s.wt, '.git', 'graft', 'maintainer.json'),
      JSON.stringify({
        reason: 'owner approved',
        scopes: ['merge'],
        grantedAt: '',
        expiresAt: '2099-01-01T00:00:00Z',
        session: 'the-session',
        via: 't',
      }),
    )
    await s.merge()
    assert.equal(s.merged(), true)
  } finally {
    s.cleanup()
  }
})

test('pr merge --auto: arms auto-merge, and merges nothing yet', async () => {
  const s = prScenario({ base: CODEOWNERS })
  try {
    await s.merge('--auto')
    assert.equal(s.client.pulls.get(7)?.autoMerge, 'MERGE')
    assert.equal(s.merged(), false)
  } finally {
    s.cleanup()
  }
})

test('pr merge --auto: a PR already mergeable (clean status) is merged now, pinned to the head it judged', async () => {
  const s = prScenario({ base: CODEOWNERS })
  try {
    const pull = s.client.pulls.get(7)
    if (pull) pull.armRefusal = 'Pull request Pull request is in clean status'
    await s.merge('--auto')
    assert.equal(s.merged(), true)
    const put = s.client.calls.find((c) => c.method === 'PUT')
    assert.equal(put?.body.sha, run(s.bare, ['rev-parse', 'refs/heads/agent/x']).trim())
  } finally {
    s.cleanup()
  }
})

test('pr merge --auto: any other refusal to arm surfaces, and nothing is merged', async () => {
  const s = prScenario({ base: CODEOWNERS })
  try {
    const pull = s.client.pulls.get(7)
    if (pull) pull.armRefusal = 'Pull request Auto merge is not allowed for this repository'
    await assert.rejects(s.merge('--auto'), /Auto merge is not allowed/)
    assert.equal(s.merged(), false)
  } finally {
    s.cleanup()
  }
})

test('pr: bad usage is a refusal, not an exit', async () => {
  await assert.rejects(
    pr(['merge', 'x'], { client: clientOver(() => null) }),
    (err) => err instanceof PublishError && /^usage: graft pr merge/.test(err.message),
  )
})
