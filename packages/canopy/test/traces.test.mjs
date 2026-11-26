// @ts-check
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveSettings } from '../src/config.mjs'
import { buildState, createHandler } from '../src/server.mjs'
import {
  anyValue,
  nanosToMs,
  parseTraces,
  spansOf,
  summarize,
  traceDetail,
  RECENT_MS,
  traceIndex,
  traceList,
  traceStore,
} from '../src/traces.mjs'
import { heartbeat, T0 } from './fixtures.mjs'

const TRACE = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const ns = (/** @type {number} */ ms) => String(BigInt(ms) * 1_000_000n)
const kv = (/** @type {Record<string, string | number | boolean>} */ o) =>
  Object.entries(o).map(([key, v]) => ({
    key,
    value:
      typeof v === 'string'
        ? { stringValue: v }
        : typeof v === 'boolean'
          ? { boolValue: v }
          : Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v },
  }))

/**
 * One line as otelcol's file exporter writes it.
 *
 * @param {{ traceId?: string, spanId: string, parent?: string, name: string, start: number, end: number,
 *   attrs?: Record<string, string | number | boolean>, error?: string }[]} spans
 */
const line = (spans, service = 'cambium') =>
  JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: kv({ 'service.name': service }) },
        scopeSpans: [
          {
            scope: { name: service },
            spans: spans.map((s) => ({
              traceId: s.traceId ?? TRACE,
              spanId: s.spanId,
              parentSpanId: s.parent ?? '',
              name: s.name,
              kind: 1,
              startTimeUnixNano: ns(T0 + s.start),
              endTimeUnixNano: ns(T0 + s.end),
              attributes: kv(s.attrs ?? {}),
              status: s.error ? { code: 2, message: s.error } : {},
            })),
          },
        ],
      },
    ],
  })

const base = { 'cambium.graph': 'task', 'cambium.repo': 'oakgreencc/monorepo', 'cambium.issue.number': 12 }

/** An issue's trace as cambium writes it over several ticks, plus an unrelated intake trace. */
const FILE = [
  line([{ spanId: '01', name: 'cambium.issue', start: 0, end: 0, attrs: base }]),
  line([
    {
      spanId: '02',
      parent: '01',
      name: 'cambium.node',
      start: 10,
      end: 900,
      attrs: { ...base, 'cambium.node': 'start-worker', 'cambium.attempt': 1, 'cambium.outcome': 'started' },
    },
  ]),
  line(
    [
      {
        spanId: '03',
        parent: '02',
        name: 'claude.session',
        start: 50,
        end: 800,
        attrs: { 'claude.model': 'opus', 'claude.cost_usd': 1.25 },
      },
      { spanId: '04', parent: '03', name: 'claude.tool', start: 60, end: 70, attrs: { 'claude.tool.name': 'Bash' } },
      { spanId: '05', parent: '03', name: 'claude.tool', start: 55, end: 58, error: 'exit 1' },
    ],
    'cambium',
  ),
  'not json',
  line([
    {
      spanId: '06',
      parent: '01',
      name: 'cambium.wait',
      start: 900,
      end: 60_000,
      attrs: { ...base, 'cambium.node': 'ci-running', 'cambium.outcome': 'merged' },
    },
  ]),
  line(
    [
      {
        traceId: OTHER,
        spanId: '11',
        name: 'mycelium.intake',
        start: 5,
        end: 6,
        attrs: { 'mycelium.source': 'discord' },
      },
    ],
    'mycelium',
  ),
  '',
].join('\n')

test('anyValue and nanosToMs read OTLP/JSON values', () => {
  assert.equal(anyValue({ intValue: '42' }), 42)
  assert.equal(anyValue({ boolValue: true }), true)
  assert.deepEqual(anyValue({ arrayValue: { values: [{ stringValue: 'a' }, { doubleValue: 1.5 }] } }), ['a', 1.5])
  assert.deepEqual(anyValue({ kvlistValue: { values: [{ key: 'k', value: { stringValue: 'v' } }] } }), { k: 'v' })
  assert.equal(anyValue(undefined), null)
  assert.equal(nanosToMs('1763294400123456789'), 1763294400123.456)
  assert.ok(Number.isNaN(nanosToMs('nope')))
})

test('spansOf: service, status, attributes, parent', () => {
  const [s] = spansOf(line([{ spanId: '05', parent: '03', name: 'claude.tool', start: 1, end: 2, error: 'boom' }]))
  assert.equal(s.service, 'cambium')
  assert.equal(s.status, 'error')
  assert.equal(s.statusMessage, 'boom')
  assert.equal(s.parentSpanId, '03')
  assert.equal(s.end - s.start, 1)
  assert.throws(() => spansOf('{'))
})

test('parseTraces groups by trace, counts malformed lines and keeps a repeated span once', () => {
  const { traces, malformed } = parseTraces([FILE, FILE])
  assert.equal(malformed, 2)
  assert.deepEqual([...traces.keys()].sort(), [TRACE, OTHER])
  assert.equal(traces.get(TRACE)?.length, 6)
})

test('summarize: issue, graph, last node and outcome, errors, cost', () => {
  const spans = /** @type {any} */ (parseTraces([FILE]).traces.get(TRACE))
  const t = summarize(TRACE, spans)
  assert.equal(t.repo, 'oakgreencc/monorepo')
  assert.equal(t.issue, 12)
  assert.equal(t.graph, 'task')
  assert.equal(t.root, 'cambium.issue')
  assert.equal(t.node, 'ci-running')
  assert.equal(t.outcome, 'merged')
  assert.equal(t.errors, 1)
  assert.equal(t.costUsd, 1.25)
  assert.equal(t.durationMs, 60_000)
  assert.deepEqual(t.services, ['cambium'])
  assert.deepEqual(t.trail, ['start-worker', 'ci-running'], 'the nodes it stepped through, oldest first')
})

test('traceDetail orders parents before children, siblings by start', () => {
  const f = /** @type {any} */ ({
    status: 'ok',
    path: 'x',
    message: null,
    files: 1,
    malformed: 0,
    ...parseTraces([FILE]),
  })
  const d = traceDetail(f, TRACE)
  assert.ok(d)
  assert.deepEqual(
    d.spans.map((s) => [s.spanId, s.depth]),
    [
      ['01', 0],
      ['02', 1],
      ['03', 2],
      ['05', 3],
      ['04', 3],
      ['06', 1],
    ],
  )
  assert.equal(traceDetail(f, 'c'.repeat(32)), null)
  const list = traceList(f)
  assert.deepEqual(
    list.traces.map((t) => t.id),
    [TRACE, OTHER],
  )
  assert.equal(traceList(f, { limit: 1 }).traces.length, 1)
  assert.deepEqual(traceIndex(f).byIssue, { 'oakgreencc/monorepo#12': TRACE })
  assert.equal(traceIndex(f).errored, 1)
  assert.deepEqual(traceIndex(f).progress['oakgreencc/monorepo#12'], {
    id: TRACE,
    graph: 'task',
    node: 'ci-running',
    outcome: 'merged',
    costUsd: 1.25,
    errors: 1,
    end: summarize(TRACE, /** @type {any} */ (f.traces.get(TRACE))).end,
    trail: ['start-worker', 'ci-running'],
  })
  const ends = [TRACE, OTHER].map((id) => summarize(id, /** @type {any} */ (f.traces.get(id))).end)
  const latest = Math.max(...ends)
  // Both traces end within a day of the later one; a day past it, neither does.
  const day = traceIndex(f, latest).recent
  assert.equal(day.runs, 2)
  assert.equal(day.errored, 1)
  assert.equal(day.costUsd, 1.25)
  assert.equal(day.sinceMs, RECENT_MS)
  assert.deepEqual(
    day.byNode.map((x) => x.n),
    [1, 1],
  )
  assert.ok(day.byNode.some((x) => x.node === 'ci-running'))
  assert.deepEqual(traceIndex(f, latest + RECENT_MS + 1).recent, {
    sinceMs: RECENT_MS,
    runs: 0,
    errored: 0,
    costUsd: null,
    byNode: [],
  })
})

test('traceDetail keeps spans caught in a parent loop', () => {
  const loop = parseTraces([
    line([
      { spanId: '01', parent: '02', name: 'x', start: 0, end: 1 },
      { spanId: '02', parent: '01', name: 'y', start: 0, end: 1 },
    ]),
  ])
  const d = traceDetail(/** @type {any} */ ({ status: 'ok', path: 'x', files: 1, malformed: 0, ...loop }), TRACE)
  assert.equal(d?.spans.length, 2)
})

test('traceStore: missing file says how to turn tracing on', async () => {
  const f = await traceStore({ path: '/nonexistent/otel/traces.jsonl' }).read()
  assert.equal(f.status, 'missing')
  assert.match(String(f.message), /OTEL_EXPORTER_OTLP_ENDPOINT/)
  assert.equal(f.traces.size, 0)
})

test('traceStore: reads rotated backups within the budget and re-reads only on change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-traces-'))
  const path = join(dir, 'traces.jsonl')
  const older = line([{ traceId: OTHER, spanId: '21', name: 'old', start: 0, end: 1 }])
  writeFileSync(join(dir, 'traces-2026-11-15T00-00-00.000.jsonl'), `${older}\n`)
  writeFileSync(join(dir, 'unrelated.jsonl'), 'junk\n')
  writeFileSync(path, FILE)
  const store = traceStore({ path })
  const a = await store.read()
  assert.equal(a.status, 'ok')
  assert.equal(a.files, 2)
  assert.equal(a.traces.get(OTHER)?.length, 2)
  assert.equal(await store.read(), a, 'unchanged files are not re-parsed')

  const tight = await traceStore({ path, budget: 1 }).read()
  assert.equal(tight.files, 1)

  writeFileSync(
    path,
    `${FILE}${line([{ spanId: '07', parent: '01', name: 'cambium.node', start: 70_000, end: 70_001 }])}\n`,
  )
  const b = await store.read()
  assert.notEqual(b, a)
  assert.equal(b.traces.get(TRACE)?.length, 7)
})

test('/api/state carries the trace index; /api/traces lists; /api/traces/<id> details; unknown id 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-traces-'))
  const path = join(dir, 'traces.jsonl')
  writeFileSync(path, FILE)
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, JSON.stringify(heartbeat()))
  const queues = {
    get: async () => ({
      repos: [],
      columns: { intake: [], waiting: [], task: [], running: [], human: [], promote: [] },
      prs: [],
    }),
  }
  const opts = {
    statePath,
    repos: ['oakgreencc/monorepo'],
    queues: /** @type {any} */ (queues),
    traces: traceStore({ path }),
  }

  const s = await buildState({ ...opts, now: () => T0 })
  assert.equal(s.traces?.status, 'ok')
  assert.equal(s.traces?.total, 2)
  assert.equal(s.traces?.byIssue['oakgreencc/monorepo#12'], TRACE)
  assert.equal((await buildState({ ...opts, traces: undefined })).traces, null)

  const handler = createHandler(opts)
  const call = (/** @type {string} */ url) =>
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
  const list = /** @type {any} */ (await call('/api/traces'))
  assert.equal(list.status, 200)
  assert.equal(JSON.parse(list.body).traces[0].id, TRACE)
  const one = /** @type {any} */ (await call(`/api/traces/${TRACE}`))
  assert.equal(one.status, 200)
  assert.equal(JSON.parse(one.body).spans.length, 6)
  assert.equal(/** @type {any} */ (await call(`/api/traces/${'c'.repeat(32)}`)).status, 404)
  assert.equal(/** @type {any} */ (await call('/api/traces/not-an-id')).status, 404)
})

test('resolveSettings: --traces, else <paths.home>/otel/traces.jsonl', () => {
  const read = (/** @type {string} */ p) => {
    if (p === '/c/home.json') return JSON.stringify({ cambium: { paths: { home: '/srv/cambium' } } })
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const deps = { home: '/home/me', read, env: {} }
  assert.equal(resolveSettings({}, deps).tracesPath, '/home/me/.oakgreen/cambium/otel/traces.jsonl')
  assert.equal(resolveSettings({ config: '/c/home.json' }, deps).tracesPath, '/srv/cambium/otel/traces.jsonl')
  assert.equal(resolveSettings({ traces: '~/t.jsonl' }, deps).tracesPath, '/home/me/t.jsonl')
})
