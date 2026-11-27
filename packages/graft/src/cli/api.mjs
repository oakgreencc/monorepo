// @ts-check
/**
 * `api`, `graphql`, `jobs` — the read path (and the tracker's write path), as
 * the App. Anything `gh` was used for goes through here, so no human
 * credential is ever needed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { jobFailed, jobLines, runIdFrom, runLine } from '../actions-jobs.mjs'
import { flag, has, positionals } from '../context.mjs'
import { PublishError } from '../errors.mjs'
import { reasonFor } from '../hooks/guard-pr-writes.mjs'
import { graphqlMergeField, restMergeTarget } from '../raw-merge.mjs'
import { COMMON_VALUE_FLAGS, contextFrom } from './common.mjs'

/**
 * The client, scoped to the right installation. `--repo` wins; else a
 * `/repos/<owner>/<repo>/` path names its own; else the checkout's origin.
 * The token covers the whole installation, so any repo in it works.
 */
async function clientForPath(argv, path = '') {
  const fromPath = /^(?:https:\/\/api\.github\.com)?\/repos\/([^/]+)\/([^/?#]+)/.exec(path)
  const ctx = contextFrom(argv, { needRoot: false, repo: fromPath ? `${fromPath[1]}/${fromPath[2]}` : null })
  return { ctx, client: await ctx.client() }
}

const API_USAGE =
  'usage: graft api <METHOD> <path> [--body <json>|--body-file <f>] [--header <k:v>]… [--include]\n' +
  '                 [--paginate] [--raw] [--out <file>] [--repo <owner/repo>]\n\n' +
  '  graft api GET /repos/o/r/pulls/12\n' +
  "  graft api GET '/repos/o/r/issues?state=open' --paginate\n" +
  '  graft api POST /repos/o/r/issues/12/comments --body \'{"body":"…"}\'\n\n' +
  'JSON is pretty-printed on stdout; a text body (job logs) is printed as-is. Use --paginate on any\n' +
  'list — a first page of 30 otherwise reads as the whole set. --raw, --paginate and --out are\n' +
  'separate output modes: pick one.\n\n' +
  "--header 'k: v' sends a request header (repeatable). --include prints the status line\n" +
  "('HTTP 200') and the ETag and rate-limit headers, a blank line, then the body. With your own\n" +
  "--header 'If-None-Match: <etag>', a 304 Not Modified is an answer, not an error: exit 0,\n" +
  "'HTTP 304' under --include and an empty body. GitHub does not count an authorized 304\n" +
  'against the rate limit.'

/**
 * The `--header k:v` values as a header object. A malformed one, or one that would replace the token, is refused.
 * @param {string[]} argv @returns {Record<string, string>}
 */
export function headersFrom(argv) {
  /** @type {Record<string, string>} */
  const out = {}
  argv.forEach((a, i) => {
    if (a !== '--header') return
    const v = argv[i + 1] ?? ''
    const at = v.indexOf(':')
    const name = at > 0 ? v.slice(0, at).trim() : ''
    if (!name || /\s/.test(name))
      throw new PublishError(`--header wants 'name: value', got ${JSON.stringify(v)}.\n\n${API_USAGE}`)
    if (name.toLowerCase() === 'authorization')
      throw new PublishError('--header cannot set Authorization: graft sends the App token itself.')
    out[name] = v.slice(at + 1).trim()
  })
  return out
}

/**
 * The `--include` head: the status line, then each kept header (`etag`, the rate-limit ones) GitHub sent, then a
 * blank line. The body follows it.
 * @param {{ status: number, headers?: Record<string, string> }} res @returns {string}
 */
export const includeHead = (res) =>
  [`HTTP ${res.status}`, ...Object.entries(res.headers ?? {}).map(([k, v]) => `${k}: ${v}`), '', ''].join('\n')

/** The output modes; each replaces the others, so asking for two is a mistake. */
const OUTPUT_MODES = ['--raw', '--paginate', '--out']

export async function runApi(argv) {
  const [method, path] = positionals(argv, [...COMMON_VALUE_FLAGS, '--body', '--body-file', '--out', '--header'])
  if (!method || !path || has(argv, '--help')) {
    console.log(API_USAGE)
    return method && path ? 0 : 1
  }
  const modes = OUTPUT_MODES.filter((f) => has(argv, f))
  if (modes.length > 1) throw new PublishError(`${modes.join(' and ')} cannot be combined — pick one.\n\n${API_USAGE}`)
  const include = has(argv, '--include')
  if (include && (has(argv, '--paginate') || has(argv, '--out')))
    throw new PublishError(
      `--include shows one answer: it cannot be combined with --paginate or --out.\n\n${API_USAGE}`,
    )
  const extra = headersFrom(argv)
  // A merge goes through `graft pr merge`, where the policy is — refused here,
  // before any client, so a runner without the hook is held to it too.
  const merge = restMergeTarget({ method, path })
  if (merge) throw new PublishError(reasonFor([merge], 'call'))
  const { client } = await clientForPath(argv, path)
  const bodyFile = flag(argv, '--body-file')
  const body = bodyFile ? readFileSync(resolve(bodyFile), 'utf8') : flag(argv, '--body')
  const init = {
    method: method.toUpperCase(),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    ...(body ? { body } : {}),
  }

  // --out writes the body as bytes. Required for anything binary — artifact
  // zips in particular, which stdout would corrupt.
  const out = flag(argv, '--out')
  if (out) {
    writeFileSync(out, await client.download(path, init))
    console.log(`wrote ${out}`)
    return 0
  }

  // --raw: exactly as GitHub sent it, for callers that parse it themselves.
  if (has(argv, '--raw')) {
    const res = await client.raw(path, init)
    console.log(`${include ? includeHead(res) : ''}${res.text}`)
    return 0
  }

  if (!has(argv, '--paginate')) {
    // A body that is not JSON (`/actions/jobs/<id>/logs`) is printed as the
    // text it is; printing `null` read as "the endpoint returned nothing".
    // A 304 (to the caller's own If-None-Match) has no body: nothing is printed.
    const res = await client.raw(path, init)
    const { text, json } = res
    const shown = res.status === 304 ? '' : json === null && text ? text : JSON.stringify(json, null, 2)
    console.log(`${include ? includeHead(res) : ''}${shown}`)
    return 0
  }

  // Array pages concatenated; a wrapped list (`{ total_count, workflow_runs:
  // [...] }`) concatenated on its one array key — see `client.paginate`.
  console.log(JSON.stringify(await client.paginate(path, init), null, 2))
  return 0
}

export async function runGraphql(argv) {
  const [query] = positionals(argv, [...COMMON_VALUE_FLAGS, '--vars', '--vars-file'])
  if (!query || has(argv, '--help')) {
    console.log(
      "usage: graft graphql '<query>' [--vars <json>|--vars-file <f>] [--repo <owner/repo>]\n\n" +
        'Required for anything with no REST surface — Projects v2 in particular.',
    )
    return query ? 0 : 1
  }
  const field = graphqlMergeField(query)
  if (field) throw new PublishError(reasonFor([{ kind: 'graphql', field }], 'call'))
  const { client } = await clientForPath(argv)
  const varsFile = flag(argv, '--vars-file')
  const varsRaw = varsFile ? readFileSync(resolve(varsFile), 'utf8') : flag(argv, '--vars')
  // client.graphql throws on an `errors` array: GraphQL answers 200 even when
  // the call failed entirely, and printing `null` would read as success.
  const data = await client.graphql(query, varsRaw ? JSON.parse(varsRaw) : {})
  console.log(JSON.stringify(data, null, 2))
  return 0
}

/**
 * The CI-failure read in one call: which job and step failed, and the logs
 * that say why, on disk. Without it this was three `api` calls and a flag
 * nobody remembered, and reports stopped at "job X failed".
 */
export async function runJobs(argv) {
  const [runArg] = positionals(argv, [...COMMON_VALUE_FLAGS, '--logs'])
  const runId = runArg ? runIdFrom(runArg) : null
  if (!runId || has(argv, '--help')) {
    console.log('usage: graft jobs <run-id | run URL> [--logs <dir>] [--all] [--repo <owner/repo>]')
    return runId ? 0 : 1
  }
  const fromUrl = /github\.com\/([^/]+)\/([^/]+)\/actions\/runs\//.exec(runArg)
  const { ctx, client } = await clientForPath(argv, fromUrl ? `/repos/${fromUrl[1]}/${fromUrl[2]}/` : '')
  const { owner, repo } = ctx.repo()
  const base = `/repos/${owner}/${repo}/actions`

  const run = await client.api(`${base}/runs/${runId}`)
  const { jobs } = await client.paginate(`${base}/runs/${runId}/jobs?per_page=100`)

  /** @type {Record<number, string>} */
  const logs = {}
  const dir = flag(argv, '--logs')
  if (dir) {
    mkdirSync(dir, { recursive: true })
    for (const j of has(argv, '--all') ? jobs : jobs.filter(jobFailed)) {
      const out = join(dir, `${j.id}.log`)
      writeFileSync(out, (await client.raw(`${base}/jobs/${j.id}/logs`)).text)
      logs[j.id] = out
    }
  }
  console.log(runLine(run))
  for (const line of jobLines(jobs, logs)) console.log(line)
  return 0
}
