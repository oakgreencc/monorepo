// @ts-check
/**
 * `cambium decide advance|show` (#165): a scripted session takes a fixture issue from `open` to `commit` through the
 * CLI, resuming from the `cambium:decide` marker alone; a bad output is refused and leaves the marker as it was.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.mjs'
import { decisionDir } from '../src/decide-session.mjs'
import { parseDecideMarker } from '../src/graphs/decide.mjs'
import { parseAnswer } from '../src/human-reply.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { harness, SLUG, T0 } from './fakes.mjs'

const N = 42
const REF = `${SLUG}#${N}`

/** A q:human ask:decide + ask:session issue whose state comment carries the ask. */
const fixture = () => ({
  number: N,
  title: 'Map page redesign',
  labels: ['q:human', 'why:triage', 'ask:decide', 'ask:session'],
  comment: {
    id: 1,
    body: renderMarker(
      newMarker({
        ask: {
          kind: 'decide',
          question: 'Which parts of the map-page redesign should be built?',
          options: [
            { label: 'Controls', detail: 'move controls top-right' },
            { label: 'Parts 2+3', detail: 'bottom panel and controls' },
          ],
          interactive: true,
          lens: 'product',
        },
      }),
    ),
  },
})

/** A temp cambium home, the CLI's io over a fake GitHub, and a way to feed one output. @param {any} [h] */
function session(h = harness({ issues: [fixture()] })) {
  const home = mkdtempSync(join(tmpdir(), 'cambium-decide-'))
  const cfg = join(home, 'config.json')
  writeFileSync(cfg, JSON.stringify({ host: 'mac', repos: [{ slug: SLUG, path: '/repo' }], paths: { home } }))
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  let stdin = ''
  const io = {
    out: (/** @type {string} */ l) => out.push(l),
    err: (/** @type {string} */ l) => err.push(l),
    env: { CAMBIUM_CONFIG: cfg, HOME: home, PATH: '/usr/bin', USER: 'james' },
    deps: () => h.deps,
    now: () => T0,
    stdin: async () => stdin,
  }
  const comments = () => h.gh.issue(N).comments
  return {
    h,
    home,
    out,
    err,
    /** `decide advance` with `output` on stdin; returns the exit code and what it printed. @param {unknown} output */
    async feed(output) {
      out.length = 0
      err.length = 0
      stdin = typeof output === 'string' ? output : JSON.stringify(output)
      const code = await main(['decide', 'advance', REF, '--output', '-'], io)
      return { code, text: out.join('\n'), errs: err.join('\n') }
    },
    async show(/** @type {string[]} */ ...extra) {
      out.length = 0
      const code = await main(['decide', 'show', REF, ...extra], io)
      return { code, text: out.join('\n') }
    },
    /** The decide marker comment's body, as GitHub holds it. */
    body: () => comments().findLast((/** @type {any} */ c) => parseDecideMarker(c.body))?.body ?? null,
    marker: () => parseDecideMarker(comments().findLast((/** @type {any} */ c) => parseDecideMarker(c.body))?.body),
    comments,
  }
}

const QUESTIONS = [
  { id: 'scope', title: 'Scope', text: 'Build parts 2 and 3 now?', rec: 'Yes: parts 2+3, they share the panel' },
  {
    id: 'laps',
    title: 'Friend laps',
    text: 'Show friend-lap counts?',
    choices: ['now', 'later'],
    rec: 'Later, as a follow-up',
  },
]
const DRAFT = {
  choice: 'Parts 2 + 3',
  inScope: ['bottom panel', 'controls top-right'],
  outOfScope: ['track label restyle'],
  acceptance: ['controls render top-right on Android and iOS'],
  followUps: [{ title: 'Friend-lap count per track', body: 'Count friend laps per track on the map page.' }],
}

test('decide show: before the first advance, the start seeded from the ask', async () => {
  const s = session()
  const { code, text } = await s.show()
  assert.equal(code, 0)
  assert.match(text, /o\/r#42 · decide \(product\) · not started · at open/)
  assert.match(text, /Question: Which parts of the map-page redesign/)
  assert.match(text, /cambium decide advance o\/r#42 --output <file\|->/)
  const json = JSON.parse((await s.show('--json')).text)
  assert.equal(json.node, 'open')
  assert.deepEqual(
    json.state.issue.options.map((/** @type {any} */ o) => o.label),
    ['Controls', 'Parts 2+3'],
  )
})

test('decide advance: a scripted session goes open → commit, resuming mid-way from the marker alone', async () => {
  const a = session()
  let r = await a.feed({})
  assert.equal(r.code, 0, r.errs)
  assert.match(r.text, /ran open/)
  assert.equal(a.marker()?.node, 'orient')
  assert.equal(a.marker()?.input.lease?.holder, 'james')

  r = await a.feed({
    facts: [{ claim: 'Track has no turn-count field', source: 'apps/mobile/src/track.ts:12' }],
    frontier: ['scope', 'laps'],
    visual: true,
  })
  assert.equal(r.code, 0, r.errs)
  assert.equal(a.marker()?.node, 'mock')

  r = await a.feed({
    mocks: [
      { option: 'Controls', html: '<!doctype html><title>Controls</title>' },
      { option: 'Parts 2+3', html: '<!doctype html><title>Parts 2+3</title>' },
    ],
  })
  assert.equal(r.code, 0, r.errs)
  assert.equal(a.marker()?.node, 'ask-round')
  const dir = decisionDir(a.home, SLUG, N)
  const mock = join(dir, 'mocks', 'parts-2-3.html')
  assert.equal(readFileSync(mock, 'utf8'), '<!doctype html><title>Parts 2+3</title>')
  assert.ok(existsSync(join(dir, 'checkpoint.md')), 'the mocks sit next to a copy of the checkpoint')

  r = await a.feed({ questions: QUESTIONS })
  assert.equal(r.code, 0, r.errs)
  assert.match(r.text, /ran ask-round/)
  assert.equal(a.marker()?.node, 'await-answers')
  assert.match(r.text, /1\. Scope \[scope\]: Build parts 2 and 3 now\?/)
  assert.match(r.text, /recommendation: Later, as a follow-up/)
  const link = /Parts 2\+3: (file:\S+)/.exec(r.text)?.[1]
  assert.ok(link, 'the round links the mock')
  assert.equal(fileURLToPath(link), mock)

  // Resume elsewhere: a fresh GitHub holding only the issue and its marker comment, a fresh home.
  const fresh = harness({
    issues: [{ ...fixture(), comments: a.comments().map((/** @type {any} */ c) => ({ ...c })) }],
  })
  const b = session(fresh)
  assert.match((await b.show()).text, /leased · at await-answers[\s\S]*Round 1:/)

  r = await b.feed({ reply: 'yes to scope; laps later' })
  assert.equal(r.code, 0, r.errs)
  assert.match(r.text, /ran await-answers/)
  assert.equal(b.marker()?.node, 'apply-answers')
  assert.match(r.text, /Reply from james: yes to scope; laps later/)

  r = await b.feed({
    answers: [
      { id: 'scope', text: 'parts 2+3' },
      { id: 'laps', text: 'later' },
    ],
    decided: ['scope', 'laps'],
    frontier: [],
  })
  assert.equal(r.code, 0, r.errs)
  assert.equal(b.marker()?.node, 'draft')

  r = await b.feed({ draft: DRAFT })
  assert.equal(r.code, 0, r.errs)
  assert.equal(b.marker()?.node, 'confirm')
  assert.match(r.text, /Draft: Parts 2 \+ 3/)
  assert.doesNotMatch(r.text, /Not complete yet/)

  r = await b.feed({ reply: 'yes', confirm: 'yes' })
  assert.equal(r.code, 0, r.errs)
  assert.match(r.text, /ran confirm → commit/)
  const m = b.marker()
  assert.equal(m?.status, 'done')
  assert.equal(m?.outcome, 'answered')
  assert.match(r.text, /Outcome: answered · https:\/\/github\.com\/o\/r\/issues\/42#issuecomment-\d+/)

  const filed = fresh.gh.calls.filter((/** @type {any} */ c) => c.op === 'createIssue')
  assert.deepEqual(
    filed.map((/** @type {any} */ c) => [c.args[1].title, c.args[1].labels]),
    [['Friend-lap count per track', ['q:intake']]],
  )
  const answer = b.comments().find((/** @type {any} */ c) => parseAnswer(c.body))
  assert.ok(answer, 'the answer comment')
  assert.equal(parseAnswer(answer.body)?.answerer, 'james')
  assert.match(answer.body, /- \[ \] controls render top-right on Android and iOS/)
  assert.match(answer.body, /#9000 Friend-lap count per track/)
  assert.equal(
    b.comments().filter((/** @type {any} */ c) => parseDecideMarker(c.body)).length,
    1,
    'one marker comment, edited in place',
  )

  const done = await b.feed({ reply: 'again' })
  assert.equal(done.code, 1)
  assert.match(done.errs, /the decision is done \(answered\)/)
})

test('decide advance: an output that fails its schema is refused with the issues listed; the marker is unchanged', async () => {
  const s = session()
  await s.feed({})
  await s.feed({ facts: [], frontier: ['scope', 'laps'] })
  assert.equal(s.marker()?.node, 'ask-round')
  const before = s.body()
  const writes = s.h.gh.calls.filter((/** @type {any} */ c) => c.op === 'writeState').length

  const six = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, title: 'T', text: 'Q?', rec: 'yes' }))
  let r = await s.feed({ questions: six })
  assert.equal(r.code, 1)
  assert.match(r.errs, /refused: this is not a valid ask-round output; the checkpoint is unchanged/)
  assert.match(r.errs, /- questions: Too big: expected array to have <=5 items/)

  r = await s.feed({ questions: [{ id: 'scope', title: 'Scope', text: 'Which?' }], extra: 1 })
  assert.equal(r.code, 1)
  assert.match(r.errs, /- questions\.0\.rec: /)
  assert.match(r.errs, /Unrecognized key: "extra"/)

  r = await s.feed('not json')
  assert.equal(r.code, 1)
  assert.match(r.errs, /- not JSON: /)

  r = await s.feed({ questions: [QUESTIONS[0], QUESTIONS[0]] })
  assert.equal(r.code, 1)
  assert.match(r.errs, /ids must be unique \(scope\)/)

  assert.equal(s.body(), before, 'the marker comment is as it was')
  assert.equal(s.h.gh.calls.filter((/** @type {any} */ c) => c.op === 'writeState').length, writes, 'nothing written')
})

test('decide advance: "yes" on an incomplete decision fails the completeness check before commit', async () => {
  const s = session()
  await s.feed({})
  await s.feed({ facts: [], frontier: ['scope', 'laps'] })
  await s.feed({ questions: QUESTIONS })
  await s.feed({ reply: 'scope: yes' })
  // Only one of the two questions answered, and the frontier forced empty: the draft is reached, but not complete.
  await s.feed({ answers: [{ id: 'scope', text: 'yes' }], decided: ['scope'], frontier: [] })
  const r0 = await s.feed({ draft: { ...DRAFT, inScope: [] } })
  assert.match(r0.text, /Not complete yet:\n {2}- round 1 question laps \("Friend laps"\) has no answer/)
  const before = s.body()
  const r = await s.feed({ reply: 'yes', confirm: 'yes' })
  assert.equal(r.code, 1)
  assert.match(r.errs, /- completeness: round 1 question laps \("Friend laps"\) has no answer/)
  assert.match(r.errs, /- completeness: the draft puts nothing in scope/)
  assert.equal(s.body(), before)

  const edit = await s.feed({ reply: 'put the panel in scope', confirm: 'edit' })
  assert.equal(edit.code, 0, edit.errs)
  assert.match(edit.text, /^ran confirm$/m)
  assert.equal(s.marker()?.node, 'draft')
})

test('decide advance: "stop" as the reply abandons; the issue gets no answer', async () => {
  const s = session()
  await s.feed({})
  await s.feed({ facts: [], frontier: ['scope'] })
  await s.feed({ questions: [QUESTIONS[0]] })
  const r = await s.feed({ reply: 'stop, not now' })
  assert.equal(r.code, 0, r.errs)
  assert.match(r.text, /ran await-answers → abandon/)
  assert.equal(s.marker()?.outcome, 'abandoned')
  assert.equal(
    s.comments().some((/** @type {any} */ c) => parseAnswer(c.body)),
    false,
  )
})

test('decide: usage, an issue with no lens, and a missing output', async () => {
  const s = session(harness({ issues: [{ number: N, labels: ['q:human'] }] }))
  assert.equal(
    await main(['decide', 'nope', REF], /** @type {any} */ ({ ...s, out: () => {}, err: () => {}, env: {} })),
    1,
  )
  const r = await s.show()
  assert.equal(r.code, 1)
  const noOutput = session()
  const missing = await main(['decide', 'advance', REF], {
    out: () => {},
    err: (/** @type {string} */ l) => noOutput.err.push(l),
    env: { CAMBIUM_CONFIG: join(noOutput.home, 'config.json') },
    deps: () => noOutput.h.deps,
  })
  assert.equal(missing, 1)
  assert.match(noOutput.err.join('\n'), /open needs the session's output: --output <file\|->/)
})
