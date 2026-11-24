// @ts-check
/**
 * Session briefs (#113): a `q:human` item worth an interactive session gets a Markdown brief under
 * `<home>/briefs/<owner>__<repo>/issue-<n>.md`, rewritten when it changes and removed when the issue leaves `q:human`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { briefPath, isSessionCandidate, redact, renderBrief } from '../src/briefs.mjs'
import { newMarker, renderMarker } from '../src/marker.mjs'
import { tick } from '../src/tick.mjs'
import { harness, SLUG } from './fakes.mjs'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwx'

const marker = (/** @type {Partial<import('../src/marker.mjs').Marker>} */ over = {}) =>
  newMarker({
    stage: 'human',
    attempt: 3,
    reworks: 1,
    failedSha: 'deadbeefcafe',
    lastFailure: '3 attempts spent. Last: CI red on PR #7',
    history: [
      { at: '2026-11-16T10:00:00Z', attempt: 1, outcome: 'failed', reason: 'tried a regex parser; tests red', pr: 7 },
      { at: '2026-11-16T11:00:00Z', attempt: 2, outcome: 'no-pr', reason: 'worker exited without a published PR' },
    ],
    ...over,
  })

/** @param {string[]} labels @param {Partial<import('../src/marker.mjs').Marker>} [over] @param {string} [body] */
const issue = (labels, over, body = 'Do the thing.\n\n## Acceptance\n- [ ] it works\n- [ ] docs updated') => ({
  number: 5,
  body,
  labels,
  comment: { id: 1, body: renderMarker(marker(over)) },
})

/** @param {any[]} issues */
function setup(issues) {
  const dir = mkdtempSync(join(tmpdir(), 'cambium-briefs-'))
  const h = harness({ issues, prs: [{ number: 7, closes: [5], state: 'OPEN', checks: 'FAILURE' }] })
  h.deps.briefs = { dir }
  return { ...h, dir, path: briefPath(dir, SLUG, 5), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('one function decides who gets a brief: q:human with why:budget, or with ask:decide + ask:session', () => {
  assert.equal(isSessionCandidate({ labels: ['q:human', 'why:budget'] }), true)
  assert.equal(isSessionCandidate({ labels: ['q:human', 'why:triage', 'ask:decide', 'ask:session'] }), true)
  assert.equal(isSessionCandidate({ labels: ['q:human', 'why:triage', 'ask:decide'] }), false)
  assert.equal(isSessionCandidate({ labels: ['q:human', 'why:triage', 'ask:chore', 'ask:session'] }), false)
  assert.equal(isSessionCandidate({ labels: ['q:intake', 'ask:decide', 'ask:session'] }), false)
  assert.equal(isSessionCandidate({ labels: ['q:human', 'why:triage'] }), false)
  assert.equal(isSessionCandidate({ labels: ['q:human', 'why:approve'] }), false)
  assert.equal(isSessionCandidate({ labels: ['q:task', 'why:budget'] }), false)
})

test('a why:budget item gets a brief with the issue, history, failure, PRs, rejected approaches and contract', async (t) => {
  const s = setup([issue(['q:human', 'why:budget']), { number: 6, labels: ['q:human', 'why:triage'] }])
  t.after(s.done)
  await tick(s.deps)
  assert.equal(s.path, join(s.dir, 'o__r', 'issue-5.md'))
  const brief = readFileSync(s.path, 'utf8')
  for (const want of [
    'Issue 5',
    'https://github.com/o/r/issues/5',
    'Do the thing.',
    '- [ ] it works',
    'Attempts: 3 of 3',
    'Reworks: 1 of 3',
    'Failed SHA: deadbeefcafe',
    'CI red on PR #7',
    '#7 open on `agent/issue-5`',
    'tried a regex parser; tests red',
    'worker exited without a published PR',
    'checked out at /repo',
    'pnpm verify',
    'graft publish agent/issue-5',
    '--closes 5',
  ])
    assert.ok(brief.includes(want), `brief lacks ${JSON.stringify(want)}`)
  assert.ok(!brief.includes('## The question'), 'no ask, no question section')
  assert.equal(existsSync(briefPath(s.dir, SLUG, 6)), false, 'a why:triage item gets no brief')
})

test('the brief is rewritten when the marker changes, left alone otherwise, and deleted on leaving q:human', async (t) => {
  const s = setup([issue(['q:human', 'why:budget'])])
  t.after(s.done)
  await tick(s.deps)
  const first = readFileSync(s.path, 'utf8')
  await tick(s.deps)
  assert.equal(s.events.filter((e) => e.msg.startsWith('session brief written')).length, 1, 'unchanged: not rewritten')

  const m = /** @type {any} */ (s.gh.issue(5))
  m.comment = { id: 1, body: renderMarker(marker({ lastFailure: 'a new failure' })) }
  await tick(s.deps)
  const second = readFileSync(s.path, 'utf8')
  assert.notEqual(second, first)
  assert.ok(second.includes('a new failure'))

  await s.gh.github.label(SLUG, 5, { add: ['q:intake'], remove: ['q:human', 'why:budget'] })
  await tick(s.deps)
  assert.equal(existsSync(s.path), false)
})

test('the brief is deleted when the issue closes', async (t) => {
  const s = setup([issue(['q:human', 'why:budget'])])
  t.after(s.done)
  await tick(s.deps)
  assert.ok(existsSync(s.path))
  await s.gh.github.close(SLUG, 5, 'done')
  await tick(s.deps)
  assert.equal(existsSync(s.path), false)
})

test('ask fields appear when the marker has them; decide options render as `N. **label**: detail` (#163)', () => {
  const base = { slug: SLUG, repoPath: '/repo', prs: [], maxAttempts: 3, maxReworks: 3 }
  const ask = {
    kind: 'decide',
    question: 'Which parser?',
    options: [
      { label: 'regex', detail: 'quick to write,\nfragile on nesting' },
      { label: 'peg', detail: 'a grammar file and a dependency' },
    ],
    recommendation: 'peg',
  }
  const i = /** @type {any} */ ({
    number: 5,
    title: 'T',
    url: 'u',
    body: '',
    labels: ['q:human', 'why:budget'],
    state: 'OPEN',
    stateComment: { id: 1, marker: { ...marker(), ask } },
  })
  const brief = renderBrief({ ...base, issue: i })
  assert.ok(brief.includes('## The question\n\nWhich parser?'))
  assert.ok(
    brief.includes(
      'Options:\n\n1. **regex**: quick to write, fragile on nesting\n2. **peg**: a grammar file and a dependency\n',
    ),
  )
  assert.ok(!brief.includes('[object Object]'))
  assert.ok(brief.includes('Recommendation: peg'))
})

const decideAsk = /** @type {any} */ ({
  kind: 'decide',
  question: 'Flag or default?',
  options: [
    { label: 'Flag', detail: 'opt-in' },
    { label: 'Default', detail: 'everyone' },
  ],
  recommendation: 'Flag',
  interactive: true,
  lens: 'product',
})
const DECIDE = ['q:human', 'why:triage', 'ask:decide', 'ask:session']

test('a decide + session item gets a brief naming the lens and /oakgreen:decide; deleted on leaving q:human', async (t) => {
  const s = setup([issue(DECIDE, { graph: 'dispatch', node: 'to-human', ask: decideAsk })])
  t.after(s.done)
  await tick(s.deps)
  const brief = readFileSync(s.path, 'utf8')
  for (const want of [
    'Start by running `/oakgreen:decide` (lens: product)',
    '## The question\n\nFlag or default?',
    '1. **Flag**: opt-in\n2. **Default**: everyone',
    'Recommendation: Flag',
    'Lens: product',
  ])
    assert.ok(brief.includes(want), `brief lacks ${JSON.stringify(want)}`)
  assert.ok(!brief.includes('what went wrong'), 'a decision is not a failure')

  await s.gh.github.label(SLUG, 5, { add: ['q:intake'], remove: DECIDE })
  await tick(s.deps)
  assert.equal(existsSync(s.path), false)
})

test('a decide + session brief is deleted when the issue closes', async (t) => {
  const s = setup([issue(DECIDE, { graph: 'dispatch', node: 'to-human', ask: decideAsk })])
  t.after(s.done)
  await tick(s.deps)
  assert.ok(existsSync(s.path))
  await s.gh.github.close(SLUG, 5, 'done')
  await tick(s.deps)
  assert.equal(existsSync(s.path), false)
})

test('briefs carry no token text', async (t) => {
  const body = `Repro:\n\n\`\`\`\nGITHUB_TOKEN=${TOKEN} graft publish\nexport ANTHROPIC_API_KEY="${ANTHROPIC}"\ncurl -H "Authorization: Bearer abcdef1234567890abcdef" https://x:hunter2secret@example.com/\n\`\`\``
  const s = setup([issue(['q:human', 'why:budget'], { lastFailure: `npm ERR! token ${TOKEN}` }, body)])
  t.after(s.done)
  await tick(s.deps)
  const brief = readFileSync(s.path, 'utf8')
  for (const secret of [TOKEN, ANTHROPIC, 'abcdef1234567890abcdef', 'hunter2secret'])
    assert.ok(!brief.includes(secret), `brief leaks ${secret}`)
  assert.ok(brief.includes('GITHUB_TOKEN=[redacted]'))
  assert.equal(redact('no secrets here: attempt 3 of 3'), 'no secrets here: attempt 3 of 3')
})
