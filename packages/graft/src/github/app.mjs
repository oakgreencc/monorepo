// @ts-check
/**
 * GitHub as a GitHub App — the credential half of Publish.
 *
 * Everything an agent writes to GitHub is authenticated with a GitHub App's
 * installation token, never a human's credential. This module mints that
 * token and wraps `fetch` so the operations in `publish.mjs` can be exercised
 * against a fake without touching the network: `fetch` is injected everywhere,
 * and the default is the global one.
 *
 * Nothing in here is specific to one App. `createClient` takes a token, so a
 * release job can drive the same primitive with its own App's token and get a
 * commit Verified as that App.
 *
 * Zero npm dependencies on purpose. `graft credential` is what git invokes as
 * its credential helper, before a worktree has any `node_modules`, so the whole
 * path has to run on bare `node`.
 */

import { createPrivateKey, createSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { graftHome, appFor, loadUserConfig } from '../config.mjs'
import { etagCache } from './http-cache.mjs'

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** Where an App's credentials live: `$GRAFT_HOME/apps/<slug>/{app.json,private-key.pem}`. */
export const appDir = (slug, env = process.env) => join(graftHome(env), 'apps', slug)

/**
 * The App id and private key that act for `owner`.
 *
 * `GRAFT_APP_ID` + `GRAFT_PRIVATE_KEY_PATH` win outright — CI, containers, and
 * anything else that injects credentials. Otherwise the App is chosen by
 * `appFor` (env `GRAFT_APP`, the project's `app`, the owner map, the machine
 * default) and read from its directory. The App id and PEM are the only key
 * material an agent session ever holds, and they are the App's, not a human's.
 *
 * @param {{ owner?: string, project?: { app?: string | null } | null, env?: NodeJS.ProcessEnv }} [input]
 * @returns {{ appId: string, keyPem: string, slug: string | null }}
 */
export function readAppCredentials({ owner, project = null, env = process.env } = {}) {
  if (env.GRAFT_APP_ID && env.GRAFT_PRIVATE_KEY_PATH) {
    return {
      appId: env.GRAFT_APP_ID,
      keyPem: readFileSync(env.GRAFT_PRIVATE_KEY_PATH, 'utf8'),
      slug: env.GRAFT_APP ?? null,
    }
  }
  const slug = appFor({ owner, project, user: loadUserConfig(env), env })
  if (!slug) throw new NoAppError(owner)
  const dir = appDir(slug, env)
  const meta = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
  return { appId: String(meta.id), keyPem: readFileSync(join(dir, 'private-key.pem'), 'utf8'), slug }
}

/** No App is configured for this owner. The credential helper reads this as "not mine". */
export class NoAppError extends Error {
  constructor(owner) {
    super(
      `no GitHub App is configured${owner ? ` for ${owner}` : ''}. ` +
        'Run `graft setup` (or set GRAFT_APP_ID and GRAFT_PRIVATE_KEY_PATH).',
    )
    this.name = 'NoAppError'
  }
}

/**
 * A short-lived JWT identifying the App itself — the bearer for the two calls
 * that turn an App into an installation token. `now` is injectable so a test
 * can pin the claims.
 */
export function appJwt({ appId, keyPem, now = Math.floor(Date.now() / 1000) }) {
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64u(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64u(signer.sign(createPrivateKey(keyPem)))}`
}

/** The response headers a refusal keeps — the ones the rate-limit rules read. */
const KEPT_HEADERS = ['etag', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']

const urlFor = (path) => (path.startsWith('http') ? path : `https://api.github.com${path}`)

/** The RFC 5988 `Link: <…>; rel="next"` target, or `null`. */
const nextLink = (res) => /<([^>]+)>;\s*rel="next"/.exec(res.headers?.get?.('link') ?? '')?.[1] ?? null

/**
 * Is `err` GitHub answering 404? The one test for "absent", for every caller:
 * `request` attaches `status`; the `<path>: 404` message is the fallback for
 * an error that did not come through it.
 */
export const isNotFound = (err) => err?.status === 404 || /: 404 /.test(String(err?.message))

/**
 * @typedef {{ status: number, text: string, json: any, next: string | null, headers?: Record<string, string>,
 *   cached?: boolean }} Response
 *   `json` is `null` for a body that is not JSON; `next` is the next page. `headers`: the {@link KEPT_HEADERS}.
 *   `cached`: answered from the ETag cache on a 304.
 */

/** How many characters of a non-JSON error body an Error message keeps. */
export const ERROR_BODY_MAX = 300

/**
 * An error answer's body, fit for one log line. JSON (GitHub's API errors) is kept, on one line, since callers
 * match on its `message`. An HTML page (a 502/504 from GitHub's edge) becomes its `<title>`; any other text is
 * collapsed onto one line and cut at {@link ERROR_BODY_MAX} characters.
 * @param {string} text
 */
export function errorBody(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  try {
    JSON.parse(t)
    return t.replace(/\s*\n\s*/g, ' ')
  } catch {}
  if (/^<(!doctype|html)/i.test(t) || /<\/(html|body)>/i.test(t)) {
    const title = t
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
    return title ? `(HTML page: ${title})` : '(HTML page)'
  }
  const line = t.replace(/\s+/g, ' ')
  return line.length > ERROR_BODY_MAX ? `${line.slice(0, ERROR_BODY_MAX)}…` : line
}

/**
 * Raw REST call. Returns `{ status, text, json, next }` so callers can page
 * and choose whether to parse. Not every endpoint returns JSON — job logs are
 * plain text behind a redirect, and blindly parsing them throws a SyntaxError
 * that looks nothing like "this endpoint isn't JSON".
 *
 * A non-2xx answer is thrown as an Error whose message is `<path>: <status>
 * <body>` (the body through {@link errorBody}: one line), carrying `status` (see {@link isNotFound}) and the
 * {@link KEPT_HEADERS} as `headers` so {@link rateLimitWait} can read them. A
 * success carries them too (`headers`), so a caller can see its budget.
 *
 * With a `cache` (http-cache.mjs), a GET is conditional: a 304 is answered
 * from the cached body, which GitHub does not count against the rate limit.
 * A caller that sends its own `If-None-Match` keeps the tag it chose: the cache
 * is skipped, and a 304 is returned as itself (`status: 304`, an empty body),
 * not thrown, since it is the answer the caller asked about.
 *
 * @param {string} path @param {RequestInit} [opts] @param {typeof globalThis.fetch} [fetchImpl]
 * @param {import('./http-cache.mjs').HttpCache | null} [cache]
 * @returns {Promise<Response>}
 */
export async function request(path, opts = {}, fetchImpl = globalThis.fetch, cache = null) {
  const url = urlFor(path)
  /** @type {Record<string, string>} */
  const sent = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    .../** @type {Record<string, string>} */ (opts.headers ?? {}),
  }
  const method = (opts.method ?? 'GET').toUpperCase()
  const conditional = Object.keys(sent).some((h) => h.toLowerCase() === 'if-none-match')
  const key = cache && method === 'GET' && !conditional ? `${sent.Accept} ${url}` : null
  const hit = key ? /** @type {import('./http-cache.mjs').HttpCache} */ (cache).get(key) : null
  const res = await fetchImpl(url, { ...opts, headers: hit ? { ...sent, 'If-None-Match': hit.etag } : sent })
  /** @type {Record<string, string>} */
  const headers = {}
  for (const h of KEPT_HEADERS) {
    const v = res.headers?.get?.(h)
    if (v !== null && v !== undefined) headers[h] = String(v)
  }
  if (res.status === 304 && hit) {
    await res.text().catch(() => '')
    cache?.touch(/** @type {string} */ (key))
    return { status: 200, text: hit.text, json: parseJson(hit.text), next: hit.next, headers, cached: true }
  }
  const text = await res.text()
  if (res.status === 304 && conditional) return { status: 304, text: '', json: null, next: null, headers }
  if (!res.ok) {
    throw Object.assign(new Error(`${path}: ${res.status} ${errorBody(text)}`), {
      status: res.status,
      headers,
    })
  }
  const next = nextLink(res)
  const etag = res.headers?.get?.('etag')
  if (key && etag && res.status === 200)
    /** @type {import('./http-cache.mjs').HttpCache} */ (cache).set(key, { etag, text, next })
  return { status: res.status, text, json: parseJson(text), next, headers }
}

/** A body as JSON, or null for one that is not (job logs: `api` prints the text). @param {string} text */
function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * Requests as the App ITSELF — the App's JWT as bearer, not an installation
 * token. The few calls that need it (find an installation, mint its token,
 * read the App) go through here, never by assembling the header.
 *
 * @param {{ appId: string, keyPem: string }} creds
 * @param {typeof globalThis.fetch} [fetch]
 * @returns {(path: string, init?: RequestInit) => Promise<Response>}
 */
export function asApp({ appId, keyPem }, fetch = globalThis.fetch) {
  return (path, init = {}) =>
    request(
      path,
      { ...init, headers: { Authorization: `Bearer ${appJwt({ appId, keyPem })}`, ...(init.headers ?? {}) } },
      fetch,
    )
}

/** Raw installation token for the installation that covers `owner/repo`. */
export async function installationToken({ owner, repo, appId, keyPem, fetch = globalThis.fetch }) {
  return (await mintToken({ owner, repo, appId, keyPem, fetch })).token
}

/** `{ token, expiresAt }` — the mint, with the expiry the cache needs. */
async function mintToken({ owner, repo, appId, keyPem, fetch = globalThis.fetch }) {
  const app = asApp({ appId, keyPem }, fetch)
  const inst = (await app(`/repos/${owner}/${repo}/installation`)).json
  const { token, expires_at } = (await app(`/app/installations/${inst.id}/access_tokens`, { method: 'POST' })).json
  return { token, expiresAt: expires_at ?? null }
}

/** A cached token is reused only while it has at least this long left. */
const TOKEN_MIN_LIFE_MS = 10 * 60 * 1000

/**
 * An installation token, from a per-owner cache when one is still good.
 *
 * Speed, not secrecy: git calls the credential helper on every fetch, and a
 * cold mint is two round trips. The cache sits in `$GRAFT_HOME/cache/` with
 * mode 0600 — the same trust as the private key beside it, which can mint the
 * token anyway. Keyed by App and OWNER, because a token covers its whole
 * installation; a repo outside the installation fails at use, not here.
 *
 * @param {{ owner: string, repo: string, appId: string, keyPem: string, env?: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch, now?: number }} input
 */
export async function cachedInstallationToken({
  owner,
  repo,
  appId,
  keyPem,
  env = process.env,
  fetch = globalThis.fetch,
  now = Date.now(),
}) {
  const dir = join(graftHome(env), 'cache')
  const file = join(dir, `token-${appId}-${owner.toLowerCase()}.json`)
  if (env.GRAFT_NO_TOKEN_CACHE !== '1' && existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'))
      if (c.token && Date.parse(c.expiresAt) - now > TOKEN_MIN_LIFE_MS) return c.token
    } catch {
      // A corrupt cache is a cold cache.
    }
  }
  const minted = await mintToken({ owner, repo, appId, keyPem, fetch })
  if (minted.expiresAt && env.GRAFT_NO_TOKEN_CACHE !== '1') {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify(minted), { mode: 0o600 })
    } catch {
      // Caching is an optimisation; failing to cache is not failing.
    }
  }
  return minted.token
}

/**
 * How many times one request is retried after a rate-limited refusal before
 * the refusal is surfaced. With the doubling in {@link rateLimitWait} this
 * is a long time — deliberately: the alternative, on a large publish, is a
 * failed run with the tree partly uploaded.
 */
export const RATE_LIMIT_RETRIES = 6

/** No single wait is longer than this, whatever the headers say. */
const MAX_WAIT_MS = 60 * 60 * 1000

/**
 * How long to wait before retrying a request GitHub refused, in ms — or
 * `null` when the refusal is not a rate limit and must be surfaced as-is.
 *
 * The rules are GitHub's, in their order of precedence: a `retry-after`
 * header is that many seconds; else `x-ratelimit-remaining: 0` means wait
 * until `x-ratelimit-reset` (epoch seconds); else a 403/429 whose body says
 * "rate limit" waits a minute. Each further `attempt` doubles the wait, which
 * is the documented backoff. Anything else — a 403 for a missing permission,
 * a 422, a network failure — is `null`.
 *
 * @param {any} err        what `request()` threw
 * @param {number} attempt 0 for the first retry
 * @param {number} [now]   ms since the epoch, injectable
 */
export function rateLimitWait(err, attempt, now = Date.now()) {
  const status = err?.status
  if (status !== 403 && status !== 429) return null
  /** @type {Record<string, string>} */
  const h = err.headers ?? {}
  let base
  if (h['retry-after'] !== undefined && Number.isFinite(Number(h['retry-after']))) {
    base = Number(h['retry-after']) * 1000
  } else if (h['x-ratelimit-remaining'] === '0' && h['x-ratelimit-reset'] !== undefined) {
    base = Number(h['x-ratelimit-reset']) * 1000 - now
  } else if (/rate limit/i.test(String(err.message))) {
    base = 60_000
  } else {
    return null
  }
  return Math.min(MAX_WAIT_MS, Math.max(1_000, base) * 2 ** attempt)
}

/** @type {(ms: number) => Promise<void>} */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** @type {(line: string) => void} */
const noop = () => {}

/**
 * How many times {@link retryServerErrors} repeats a request GitHub answered
 * with a 5xx, or that died on a dropped connection. With the doubling in
 * {@link serverErrorWait} that is 1+2+4+8s.
 */
export const SERVER_ERROR_RETRIES = 4

const SERVER_ERRORS = new Set([500, 502, 503, 504])

/**
 * The `cause.code`s of a `fetch failed` whose connection dropped under it —
 * typically a keep-alive socket that went stale while git hooks ran.
 */
const DROPPED_CONNECTION = new Set(['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE'])

/**
 * The code of a request that died on a dropped connection, or `null`.
 *
 * @param {any} err
 * @returns {string | null}
 */
export function droppedConnection(err) {
  const code = err?.cause?.code ?? err?.code
  return DROPPED_CONNECTION.has(code) ? code : null
}

/**
 * How long to wait before repeating a request GitHub answered 500, 502, 503
 * or 504, or that died on a dropped connection ({@link droppedConnection}) —
 * one second, doubling per `attempt` — or `null` for anything else.
 *
 * Deliberately NOT part of {@link rateLimitWait} or the client's own retry
 * (which repeats only a GET or HEAD whose connection dropped): a 5xx, or a connection that dropped mid-request, does not say whether
 * GitHub performed the write. Repeating is safe only for a content-addressed
 * write — `POST /git/blobs`, `POST /git/trees`, whose answer is a sha fixed by
 * the body — and never for `POST /git/commits` (a second commit object) or a
 * ref update. So the caller opts in, per call site, with {@link retryServerErrors}.
 *
 * @param {any} err        what `request()` threw
 * @param {number} attempt 0 for the first retry
 */
export function serverErrorWait(err, attempt) {
  return SERVER_ERRORS.has(err?.status) || droppedConnection(err) ? 1_000 * 2 ** attempt : null
}

/**
 * Run `call`, repeating it on a 5xx or a dropped connection (see
 * {@link serverErrorWait}) up to `retries` times and `report`ing each wait.
 * For idempotent, content-addressed writes only; `label` names the request in
 * the report.
 *
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} call
 * @param {{ sleep?: (ms: number) => Promise<void>, report?: (line: string) => void, retries?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function retryServerErrors(
  label,
  call,
  { sleep = defaultSleep, report = noop, retries = SERVER_ERROR_RETRIES } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (err) {
      const wait = attempt < retries ? serverErrorWait(err, attempt) : null
      if (wait === null) throw err
      const dropped = droppedConnection(err)
      report(
        `${dropped ? `connection dropped (${dropped})` : `server error (${/** @type {any} */ (err).status})`} on ${label}: waiting ${Math.ceil(wait / 1000)}s (retry ${attempt + 1}/${retries})`,
      )
      await sleep(wait)
    }
  }
}

/**
 * A request that failed before GitHub answered (undici's bare `fetch failed`)
 * says neither which request it was nor why. Name both — `GET /path: fetch
 * failed (UND_ERR_SOCKET)` — keeping the original as `cause`'s source so
 * {@link droppedConnection} still reads its code. An HTTP refusal (it has a
 * `status`, and its message already names the path) is returned untouched.
 *
 * @param {any} err
 * @param {string} method
 * @param {string} path
 */
function labelled(err, method, path) {
  if (!(err instanceof Error) || /** @type {any} */ (err).status !== undefined) return err
  const code = err?.cause?.code ?? err?.code
  const why = err?.cause?.message
  const detail = [code, why && why !== err.message ? why : null].filter(Boolean).join(': ')
  const out = new Error(`${method} ${path}: ${err.message}${detail ? ` (${detail})` : ''}`, {
    cause: err.cause ?? err,
  })
  if (err?.code !== undefined) Object.assign(out, { code: err.code })
  return out
}

/**
 * An authenticated client — the one port every GitHub call goes through:
 *
 *   api(path, init?)          parsed JSON
 *   json(path, method, body)  a JSON write
 *   raw(path, init?)          the whole {@link Response}: text, status, next page
 *   getOrNull(path)           parsed JSON, or `null` when GitHub answers 404
 *   paginate(path, init?)     every page of a list, concatenated — a bare array,
 *                             or a wrapper (`{ total_count, jobs: […] }`) with its
 *                             one array concatenated; a non-list is returned as is
 *   download(path, init?)     the body as bytes (artifact zips, which text corrupts)
 *   graphql(query, vars?)     `data`, or a throw on an `errors` array
 *
 * Every request carries the token; a caller never assembles an Authorization
 * header itself. Built from a token rather than from credentials so the same
 * client serves any App — and over any `fetch`, which is the seam the tests
 * use: the real client, over a fake GitHub.
 *
 * A rate-limited refusal (403/429, see {@link rateLimitWait}) is waited out
 * and the request repeated, up to {@link RATE_LIMIT_RETRIES} times, and each
 * wait is `report`ed so a publish that is pausing says why. Safe to repeat:
 * GitHub performed nothing for a request it refused. A GET or HEAD whose
 * connection dropped ({@link droppedConnection}) — a keep-alive socket gone
 * stale while a git hook ran — is repeated too, up to
 * {@link SERVER_ERROR_RETRIES} times: a read performed nothing either. A
 * write that dropped is never repeated here. A request that fails before
 * GitHub answers is rethrown naming its method, path and `cause.code`.
 * `sleep` is injectable so tests do not wait.
 *
 * @param {{ token: string | undefined, fetch?: typeof globalThis.fetch, sleep?: (ms: number) => Promise<void>, report?: (line: string) => void, retries?: number, cache?: import('./http-cache.mjs').HttpCache | null }} input
 *   `cache`: a conditional-GET cache (http-cache.mjs); only {@link clientFor} gives one, so tests and one-off
 *   clients never touch the disk.
 */
export function createClient({
  token,
  fetch = globalThis.fetch,
  sleep = defaultSleep,
  report = noop,
  retries = RATE_LIMIT_RETRIES,
  cache = null,
}) {
  const auth = { Authorization: `token ${token}` }
  const withAuth = (init = {}) => ({ ...init, headers: { ...auth, ...(init.headers ?? {}) } })
  const raw = async (path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const read = method === 'GET' || method === 'HEAD'
    let dropRetries = 0
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(path, withAuth(init), fetch, cache)
      } catch (err) {
        // A read is safe to repeat on a dropped connection — typically a
        // keep-alive socket gone stale while a git hook ran — because it
        // performed nothing. A write is not (see serverErrorWait).
        const dropped = read ? droppedConnection(err) : null
        if (dropped && dropRetries < SERVER_ERROR_RETRIES) {
          const wait = 1_000 * 2 ** dropRetries++
          report(
            `connection dropped (${dropped}) on ${method} ${path}: waiting ${Math.ceil(wait / 1000)}s (retry ${dropRetries}/${SERVER_ERROR_RETRIES})`,
          )
          await sleep(wait)
          continue
        }
        const wait = attempt < retries ? rateLimitWait(err, attempt) : null
        if (wait === null) throw labelled(err, method, path)
        report(
          `rate limited (${/** @type {any} */ (err).status}) on ${method} ${path}: waiting ${Math.ceil(wait / 1000)}s (retry ${attempt + 1}/${retries})`,
        )
        await sleep(wait)
      }
    }
  }
  const api = async (path, init) => (await raw(path, init)).json
  const json = (path, method, body) =>
    api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  // GraphQL answers 200 with an `errors` array, so a non-throwing call can
  // still have failed entirely; that is surfaced as a throw here, once, rather
  // than by every caller. The release path needs this for `updateRefs` — the
  // one write REST cannot express: several refs moved atomically.
  const graphql = async (query, variables = {}) => {
    const { json: out, headers } = await raw('https://api.github.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if (out?.errors?.length) {
      // GitHub answers a spent GraphQL budget with 200 and a RATE_LIMIT error, not a 403, so it never reaches
      // rateLimitWait. Say when it resets, so a poller can sit it out instead of asking every tick.
      const limited = out.errors.some((/** @type {any} */ e) => e?.type === 'RATE_LIMIT')
      const reset = Number(headers?.['x-ratelimit-reset'])
      const until = limited && reset > 0 ? new Date(reset * 1000).toISOString() : null
      throw Object.assign(
        new Error(
          `graphql: ${limited ? `rate limited${until ? ` until ${until}` : ''}: ` : ''}${JSON.stringify(out.errors)}`,
        ),
        limited ? { rateLimited: true, resetAt: until } : {},
      )
    }
    return out?.data ?? null
  }
  const getOrNull = async (path) => {
    try {
      return await api(path)
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }
  const paginate = async (path, init) => {
    /** @type {any[] | null} */
    let all = null
    /** @type {any} */
    let wrapper = null
    /** @type {string | null} */
    let next = path
    while (next) {
      const page = await raw(next, init)
      const body = page.json
      if (Array.isArray(body)) {
        all ??= []
        all.push(...body)
      } else {
        const key = body && typeof body === 'object' ? Object.keys(body).find((k) => Array.isArray(body[k])) : undefined
        if (!key) return body // not a list at all
        wrapper ??= { ...body, [key]: [] }
        wrapper[key].push(...body[key])
      }
      next = page.next
    }
    return wrapper ?? all ?? []
  }
  const download = async (path, init = {}) => {
    const res = await fetch(urlFor(path), withAuth(init))
    if (!res.ok)
      throw Object.assign(new Error(`${path}: ${res.status} ${errorBody(await res.text())}`), { status: res.status })
    return Buffer.from(await res.arrayBuffer())
  }
  return { api, json, raw, getOrNull, paginate, download, graphql }
}

/** @typedef {ReturnType<typeof createClient>} Client */

/**
 * The usual way in: credentials → installation token → client. `report` is
 * where the client's rate-limit waits go (see `createClient`).
 *
 * @param {{ owner: string, repo: string, project?: { app?: string | null } | null, env?: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch, report?: (line: string) => void }} input
 */
export async function clientFor({ owner, repo, project = null, env = process.env, fetch = globalThis.fetch, report }) {
  const { appId, keyPem } = readAppCredentials({ owner, project, env })
  const token = await cachedInstallationToken({ owner, repo, appId, keyPem, env, fetch })
  return createClient({ token, fetch, report, cache: httpCacheFor(env) })
}

/**
 * The conditional-GET cache under `$GRAFT_HOME/cache/http/`, or null when `GRAFT_HTTP_CACHE=0`.
 * @param {NodeJS.ProcessEnv} env
 */
export function httpCacheFor(env = process.env) {
  return env.GRAFT_HTTP_CACHE === '0' ? null : etagCache(join(graftHome(env), 'cache', 'http'))
}
