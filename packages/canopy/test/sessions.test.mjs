// @ts-check
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveSettings } from '../src/config.mjs'
import { createHandler } from '../src/server.mjs'
import { sessionIdOf, sessionLogs, transcriptOf } from '../src/sessions.mjs'
import { traceStore } from '../src/traces.mjs'
import { T0 } from './fixtures.mjs'

const SID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
const OTHER_SID = '11111111-2222-3333-4444-555555555555'
const ts = (/** @type {number} */ s) => new Date(T0 + s * 1000).toISOString()

/** A worker's stdout as `claude -p --output-format stream-json --verbose` writes it. */
const streamLog = (sid = SID) =>
  [
    { type: 'system', subtype: 'hook_started', session_id: sid },
    { type: 'system', subtype: 'init', session_id: sid, cwd: '/w/triage-12', model: 'claude-opus-5-5' },
    {
      type: 'assistant',
      timestamp: ts(1),
      message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Check the blocker first.' }] },
    },
    {
      type: 'assistant',
      timestamp: ts(2),
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'graft issue read 11' } }],
      },
    },
    { type: 'rate_limit_event', rate_limit_info: {} },
    'not json',
    {
      type: 'user',
      timestamp: ts(4),
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"state":"open"}' }] },
    },
    {
      type: 'assistant',
      timestamp: ts(5),
      message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Agent', input: { prompt: 'look' } }] },
    },
    {
      type: 'assistant',
      timestamp: ts(6),
      parent_tool_use_id: 't2',
      message: { id: 'm3', content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/x' } }] },
    },
    {
      type: 'user',
      timestamp: ts(7),
      parent_tool_use_id: 't2',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't3', is_error: true, content: [{ type: 'text', text: 'ENOENT' }] },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: ts(8),
      message: { id: 'm4', content: [{ type: 'text', text: 'Blocked by #11; leaving it.' }] },
    },
    { type: 'result', subtype: 'success', session_id: sid, total_cost_usd: 0.25, num_turns: 4, result: 'blocked' },
  ]
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join('\n')

test('transcriptOf: prompt, thinking, tools with results folded in, subagent work marked, the result; noise skipped', () => {
  const t = transcriptOf(streamLog(), { prompt: 'Triage #12.' })
  assert.equal(t.sessionId, SID)
  assert.equal(t.model, 'claude-opus-5-5')
  assert.equal(t.cwd, '/w/triage-12')
  assert.equal(t.malformed, 1)
  assert.deepEqual(
    t.entries.map((e) => e.kind),
    ['prompt', 'thinking', 'tool', 'tool', 'tool', 'text', 'result'],
  )
  const [prompt, thinking, bash, agent, read, text, result] = /** @type {any[]} */ (t.entries)
  assert.equal(prompt.text, 'Triage #12.')
  assert.equal(thinking.text, 'Check the blocker first.')
  assert.equal(thinking.at, T0 + 1000)
  assert.deepEqual(
    { name: bash.name, input: bash.input, result: bash.result, error: bash.error, doneAt: bash.doneAt, sub: bash.sub },
    {
      name: 'Bash',
      input: 'graft issue read 11',
      result: '{"state":"open"}',
      error: false,
      doneAt: T0 + 4000,
      sub: false,
    },
  )
  assert.equal(agent.result, null, 'an unanswered tool call keeps a null result')
  assert.deepEqual(
    { sub: read.sub, error: read.error, result: read.result },
    { sub: true, error: true, result: 'ENOENT' },
  )
  assert.equal(text.text, 'Blocked by #11; leaving it.')
  assert.deepEqual(
    { subtype: result.subtype, error: result.error, costUsd: result.costUsd, turns: result.turns, text: result.text },
    { subtype: 'success', error: false, costUsd: 0.25, turns: 4, text: 'blocked' },
  )
})

test("transcriptOf: Claude Code's own transcript; its first user message is the prompt, kept once; meta skipped", () => {
  const log = [
    { type: 'user', sessionId: SID, isMeta: true, timestamp: ts(0), message: { content: 'caveat' } },
    { type: 'user', sessionId: SID, timestamp: ts(0), message: { role: 'user', content: 'Triage #12.' } },
    {
      type: 'assistant',
      sessionId: SID,
      timestamp: ts(1),
      message: { id: 'm1', content: [{ type: 'text', text: 'ok' }] },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')
  assert.deepEqual(
    transcriptOf(log).entries.map((e) => [e.kind, /** @type {any} */ (e).text]),
    [
      ['user', 'Triage #12.'],
      ['text', 'ok'],
    ],
  )
  assert.deepEqual(
    transcriptOf(log, { prompt: 'Triage #12.' }).entries.map((e) => e.kind),
    ['prompt', 'text'],
  )
})

test('transcriptOf clips long text and tool output', () => {
  const big = 'x'.repeat(50_000)
  const log = [
    {
      type: 'assistant',
      message: {
        id: 'm',
        content: [
          { type: 'text', text: big },
          { type: 'tool_use', id: 't', name: 'Read', input: {} },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')
  const [text, tool] = /** @type {any[]} */ (transcriptOf(log).entries)
  assert.equal(text.text.length, 20_000)
  assert.ok(text.text.endsWith('…'))
  assert.equal(tool.result.length, 4_000)
})

test('sessionIdOf reads the first session id a log names', () => {
  assert.equal(sessionIdOf(streamLog()), SID)
  assert.equal(sessionIdOf('{"type":"x"}\n'), null)
})

/** A cambium logs dir with two runs of oakgreencc/monorepo#12, and a Claude Code projects dir. */
function fixtureDirs() {
  const root = mkdtempSync(join(tmpdir(), 'canopy-sessions-'))
  const issueDir = join(root, 'logs', 'oakgreencc__monorepo', 'issue-12')
  mkdirSync(issueDir, { recursive: true })
  writeFileSync(join(issueDir, 'a1-2026-01-01T00-00-00-000Z.out.log'), streamLog(OTHER_SID))
  writeFileSync(join(issueDir, 'a2-2026-01-01T01-00-00-000Z.out.log'), streamLog())
  writeFileSync(join(issueDir, 'a2-2026-01-01T01-00-00-000Z.prompt.md'), 'Triage #12.')
  const projects = join(root, 'projects')
  mkdirSync(join(projects, '-w-other'), { recursive: true })
  mkdirSync(join(projects, '-w-triage-9'), { recursive: true })
  const nativeSid = '99999999-8888-7777-6666-555555555555'
  writeFileSync(
    join(projects, '-w-triage-9', `${nativeSid}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: nativeSid, message: { content: 'Triage #9.' } }),
  )
  return { root, logs: join(root, 'logs'), projects, issueDir, nativeSid }
}

test("sessionLogs.find: cambium's log for the issue with its prompt, else Claude Code's transcript, else missing", async () => {
  const { logs, projects, issueDir, nativeSid } = fixtureDirs()
  const store = sessionLogs({ logs, projects })
  const hit = /** @type {any} */ (await store.find({ repo: 'oakgreencc/monorepo', issue: 12, sessionId: SID }))
  assert.equal(hit.status, 'ok')
  assert.equal(hit.source, 'cambium')
  assert.equal(hit.path, join(issueDir, 'a2-2026-01-01T01-00-00-000Z.out.log'))
  assert.equal(hit.promptPath, join(issueDir, 'a2-2026-01-01T01-00-00-000Z.prompt.md'))
  assert.equal(hit.entries[0].text, 'Triage #12.')
  const older = /** @type {any} */ (await store.find({ repo: 'oakgreencc/monorepo', issue: 12, sessionId: OTHER_SID }))
  assert.equal(older.promptPath, null, 'no prompt file beside it')

  const native = /** @type {any} */ (await store.find({ repo: 'oakgreencc/monorepo', issue: 9, sessionId: nativeSid }))
  assert.equal(native.source, 'claude')
  assert.equal(native.entries[0].text, 'Triage #9.')

  const gone = await store.find({
    repo: 'oakgreencc/monorepo',
    issue: 12,
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  })
  assert.equal(gone.status, 'missing')
  assert.match(/** @type {any} */ (gone).message, /oakgreencc\/monorepo#12/)
  assert.equal((await store.find({ repo: null, issue: null, sessionId: '../../etc/passwd' })).status, 'missing')
})

test('/api/traces/<id>/sessions/<session>: only a session that trace names', async () => {
  const { root, logs, projects } = fixtureDirs()
  const ns = (/** @type {number} */ ms) => String(BigInt(T0 + ms) * 1_000_000n)
  const kv = (/** @type {Record<string, string | number>} */ o) =>
    Object.entries(o).map(([key, v]) => ({
      key,
      value: typeof v === 'string' ? { stringValue: v } : { intValue: String(v) },
    }))
  const TRACE = 'a'.repeat(32)
  const span = (/** @type {string} */ spanId, /** @type {string} */ name, /** @type {any} */ attrs, parent = '') => ({
    traceId: TRACE,
    spanId,
    parentSpanId: parent,
    name,
    startTimeUnixNano: ns(0),
    endTimeUnixNano: ns(1000),
    attributes: kv(attrs),
  })
  const path = join(root, 'traces.jsonl')
  writeFileSync(
    path,
    JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: kv({ 'service.name': 'cambium' }) },
          scopeSpans: [
            {
              spans: [
                span('01', 'cambium.issue', { 'cambium.repo': 'oakgreencc/monorepo', 'cambium.issue.number': 12 }),
                span('02', 'claude.session', { 'claude.session_id': SID }, '01'),
              ],
            },
          ],
        },
      ],
    }),
  )
  const handler = createHandler({
    statePath: join(root, 'state.json'),
    repos: ['oakgreencc/monorepo'],
    queues: /** @type {any} */ ({ get: async () => ({}) }),
    traces: traceStore({ path }),
    sessions: sessionLogs({ logs, projects }),
  })
  const call = (/** @type {string} */ url) =>
    /** @type {Promise<{ status: number, body: string }>} */ (
      new Promise((resolve) => {
        /** @type {any} */
        const res = {
          writeHead: (/** @type {number} */ status) => {
            res.status = status
          },
          end: (/** @type {string} */ body) => resolve({ status: res.status, body }),
        }
        handler(/** @type {any} */ ({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } }), res)
      })
    )
  const ok = await call(`/api/traces/${TRACE}/sessions/${SID}`)
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body)
  assert.equal(body.status, 'ok')
  assert.equal(body.entries.at(-1).kind, 'result')
  assert.equal(
    (await call(`/api/traces/${TRACE}/sessions/${OTHER_SID}`)).status,
    404,
    'a session the trace does not name',
  )
  assert.equal((await call(`/api/traces/${'c'.repeat(32)}/sessions/${SID}`)).status, 404)
})

test('resolveSettings: --logs, else paths.logs, else <paths.home>/logs', () => {
  const home = '/h'
  const read = (/** @type {any} */ cambium) => () => JSON.stringify({ cambium })
  assert.equal(resolveSettings({}, { env: {}, home, read: read({}) }).logsPath, '/h/.oakgreen/cambium/logs')
  assert.equal(resolveSettings({}, { env: {}, home, read: read({ paths: { home: '/c' } }) }).logsPath, '/c/logs')
  assert.equal(resolveSettings({}, { env: {}, home, read: read({ paths: { logs: '~/l' } }) }).logsPath, '/h/l')
  assert.equal(
    resolveSettings({ logs: '/x' }, { env: {}, home, read: read({ paths: { logs: '~/l' } }) }).logsPath,
    '/x',
  )
})
