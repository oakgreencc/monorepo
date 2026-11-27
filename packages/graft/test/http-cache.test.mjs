// @ts-check
/**
 * The conditional-GET cache (http-cache.mjs) through the real client, and the GraphQL rate-limit error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, httpCacheFor } from '../src/github/app.mjs'
import { etagCache, MAX_AGE_MS } from '../src/github/http-cache.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'graft-http-'))

/**
 * A GitHub that tags `/repos/o/r` with `"v<version>"` and answers 304 to a matching `If-None-Match`.
 * @param {{ version: number }} state
 */
function taggingGitHub(state) {
  /** @type {{ url: string, inm: string | null, method: string }[]} */
  const seen = []
  const fetch = /** @type {typeof globalThis.fetch} */ (
    async (url, init = {}) => {
      const h = /** @type {Record<string, string>} */ (init.headers ?? {})
      seen.push({ url: String(url), inm: h['If-None-Match'] ?? null, method: init.method ?? 'GET' })
      const etag = `"v${state.version}"`
      if (h['If-None-Match'] === etag) return new Response(null, { status: 304, headers: { etag } })
      return new Response(JSON.stringify({ version: state.version }), {
        status: 200,
        headers: { etag, 'x-ratelimit-remaining': '4999' },
      })
    }
  )
  return { fetch, seen }
}

test('a repeated GET is conditional; a 304 is answered from the cache, a change is read fresh', async () => {
  const state = { version: 1 }
  const gh = taggingGitHub(state)
  const client = createClient({ token: 't', fetch: gh.fetch, cache: etagCache(dir()) })
  assert.deepEqual(await client.api('/repos/o/r'), { version: 1 })
  assert.equal(gh.seen[0].inm, null)
  const again = await client.raw('/repos/o/r')
  assert.deepEqual(again.json, { version: 1 })
  assert.equal(again.cached, true)
  assert.equal(gh.seen[1].inm, '"v1"')
  state.version = 2
  assert.deepEqual(await client.api('/repos/o/r'), { version: 2 })
  assert.equal((await client.raw('/repos/o/r')).cached, true)
})

test('no cache, a write, or another Accept: nothing is conditional', async () => {
  const gh = taggingGitHub({ version: 1 })
  const plain = createClient({ token: 't', fetch: gh.fetch })
  await plain.api('/repos/o/r')
  await plain.api('/repos/o/r')
  assert.deepEqual(
    gh.seen.map((s) => s.inm),
    [null, null],
  )
  const cached = createClient({ token: 't', fetch: gh.fetch, cache: etagCache(dir()) })
  await cached.api('/repos/o/r')
  await cached.raw('/repos/o/r', { headers: { Accept: 'application/vnd.github.raw' } })
  await cached.raw('/repos/o/r', { method: 'PATCH', body: '{}' })
  assert.deepEqual(
    gh.seen.slice(2).map((s) => s.inm),
    [null, null, null],
  )
})

test('a corrupt entry is a miss; a stale one is pruned on the next write; GRAFT_HTTP_CACHE=0 turns it off', () => {
  const d = dir()
  const cache = etagCache(d)
  cache.set('k', { etag: '"a"', text: '{}', next: null })
  const [name] = readdirSync(d)
  writeFileSync(join(d, name), 'not json')
  assert.equal(cache.get('k'), null)
  const old = (Date.now() - MAX_AGE_MS - 1000) / 1000
  utimesSync(join(d, name), old, old)
  cache.set('other', { etag: '"b"', text: '{}', next: null })
  assert.equal(readdirSync(d).length, 1)
  assert.equal(httpCacheFor({ GRAFT_HTTP_CACHE: '0' }), null)
  assert.ok(httpCacheFor({ GRAFT_HOME: d }))
})

test('an entry read by a 304 within the window survives the prune; an unread one of the same age does not', async () => {
  const d = dir()
  const gh = taggingGitHub({ version: 1 })
  const client = createClient({ token: 't', fetch: gh.fetch, cache: etagCache(d) })
  await client.api('/repos/o/r')
  await client.api('/repos/o/other')
  const old = (Date.now() - MAX_AGE_MS - 1000) / 1000
  for (const name of readdirSync(d)) utimesSync(join(d, name), old, old)
  assert.equal((await client.raw('/repos/o/r')).cached, true)
  etagCache(d).set('fresh', { etag: '"c"', text: '{}', next: null })
  assert.equal(readdirSync(d).length, 2)
  const reread = gh.seen.length
  assert.equal((await client.raw('/repos/o/r')).cached, true)
  assert.equal(gh.seen[reread].inm, '"v1"')
  assert.equal((await client.raw('/repos/o/other')).cached, undefined)
  assert.equal(gh.seen[reread + 1].inm, null)
})

test('touch on a missing entry is a no-op', () => {
  assert.doesNotThrow(() => etagCache(dir()).touch('nope'))
})

test('graphql: a RATE_LIMIT error says when the budget resets', async () => {
  const reset = Math.floor(Date.parse('2026-11-24T03:00:00Z') / 1000)
  const fetch = /** @type {typeof globalThis.fetch} */ (
    async () =>
      new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMIT', message: 'API rate limit already exceeded' }] }), {
        status: 200,
        headers: { 'x-ratelimit-reset': String(reset), 'x-ratelimit-remaining': '0' },
      })
  )
  const client = createClient({ token: 't', fetch })
  await assert.rejects(client.graphql('query{viewer{login}}'), (err) => {
    const e = /** @type {any} */ (err)
    assert.match(e.message, /^graphql: rate limited until 2026-11-24T03:00:00\.000Z: \[/)
    assert.equal(e.rateLimited, true)
    assert.equal(e.resetAt, '2026-11-24T03:00:00.000Z')
    return true
  })
})

test("a caller's own If-None-Match skips the cache; its 304 is returned with the ETag, not thrown", async () => {
  const state = { version: 1 }
  const gh = taggingGitHub(state)
  const client = createClient({ token: 't', fetch: gh.fetch, cache: etagCache(dir()) })
  await client.api('/repos/o/r')
  const same = await client.raw('/repos/o/r', { headers: { 'If-None-Match': '"v1"' } })
  assert.equal(same.status, 304)
  assert.equal(same.text, '')
  assert.equal(same.cached, undefined)
  assert.equal(same.headers?.etag, '"v1"')
  const stale = await client.raw('/repos/o/r', { headers: { 'if-none-match': '"v0"' } })
  assert.equal(stale.status, 200)
  assert.deepEqual(stale.json, { version: 1 })
  assert.equal(stale.headers?.etag, '"v1"')
  state.version = 2
  const moved = await client.raw('/repos/o/r', { headers: { 'If-None-Match': '"v1"' } })
  assert.equal(moved.status, 200)
  assert.equal(moved.headers?.etag, '"v2"')
})
