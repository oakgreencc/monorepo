// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ask, askError, askLabels, renderAsk } from '../src/ask.mjs'
import { apply, move } from '../src/labels.mjs'
import { newMarker, parseMarker, renderMarker } from '../src/marker.mjs'
import { TriageResult } from '../src/phases/dispatch.mjs'

const decide = {
  kind: /** @type {const} */ ('decide'),
  question: 'Ship it as a flag or a default?',
  options: [
    { label: 'Flag', detail: 'Opt-in; nobody is surprised.' },
    { label: 'Default', detail: 'Everyone gets it; a migration note.' },
  ],
  recommendation: 'Flag',
  interactive: false,
}

test('Ask: kinds, and options (two or more) required for decide', () => {
  assert.equal(Ask.safeParse(decide).success, true)
  assert.equal(Ask.safeParse({ kind: 'chore', question: 'Fill in the LLC form.', interactive: false }).success, true)
  const err = (/** @type {unknown} */ a) => {
    const r = Ask.safeParse(a)
    return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  }
  assert.match(err({ ...decide, options: undefined }), /options: a decide ask needs two or more options/)
  assert.match(err({ ...decide, options: [decide.options[0]] }), /options:/)
  assert.match(err({ ...decide, kind: 'ponder' }), /kind:/)
  assert.match(err({ ...decide, interactive: undefined }), /interactive:/)
})

test('TriageResult accepts a valid ask and drops an invalid one without failing the verdict', () => {
  const ok = TriageResult.parse({ verdict: 'needs-human', reason: 'r', ask: decide })
  assert.deepEqual(ok.ask, decide)
  const bad = TriageResult.safeParse({ verdict: 'needs-human', reason: 'r', ask: { kind: 'decide', question: 'q' } })
  assert.equal(bad.success, true)
  assert.equal(bad.data?.ask, undefined)
})

test('askLabels: ask:<kind>, plus ask:session when interactive', () => {
  assert.deepEqual(askLabels(decide), ['ask:decide'])
  assert.deepEqual(askLabels({ ...decide, interactive: true }), ['ask:decide', 'ask:session'])
  assert.deepEqual(askLabels(undefined), [])
})

test('move: ask:* comes with q:human and leaves with it; a new hand-off replaces it', () => {
  const into = move(['q:intake', 'running'], 'q:human', { extra: ['why:triage', 'ask:chore'] })
  const human = apply(['q:intake', 'running'], into)
  assert.deepEqual(human.sort(), ['ask:chore', 'q:human', 'why:triage'])
  // A human reply sends it back to triage: why:* and ask:* leave with q:human.
  assert.deepEqual(move(human, 'q:intake').remove.sort(), ['ask:chore', 'q:human', 'why:triage'])
  // Staying in q:human (the PR graph merging a green PR) keeps the ask.
  assert.deepEqual(move(human, 'q:human', { running: true }).remove, [])
  // A new hand-off with its own reason replaces the ask.
  assert.deepEqual(move(human, 'q:human', { extra: ['why:rescue', 'ask:verify'] }).remove, ['ask:chore'])
})

test('the state comment renders the ask at to-human: question, options, recommendation', () => {
  const body = renderMarker(newMarker({ graph: 'dispatch', phase: 'dispatch', node: 'to-human', ask: decide }))
  assert.ok(
    body.includes(
      [
        '**Decide:** Ship it as a flag or a default?',
        '',
        '1. **Flag**: Opt-in; nobody is surprised.',
        '2. **Default**: Everyone gets it; a migration note.',
        '',
        '**Recommendation:** Flag',
        '',
        '_Answer with one comment naming your choice; cambium triages the issue again on your reply._',
      ].join('\n'),
    ),
    body,
  )
  const chore = renderAsk({ kind: 'chore', question: 'Upload the\nscreenshots.', interactive: true }).join('\n')
  assert.match(chore, /^\*\*Offline chore:\*\* Upload the screenshots\.\n\n_Comment when it is done/)
  assert.match(chore, /A live session with the code would help here\._$/)
  // Not at to-human (it moved on), or done: no ask.
  assert.doesNotMatch(renderMarker(newMarker({ node: 'start-worker', ask: decide })), /Decide:/)
})

test('lens: optional, required on an interactive decide; an unknown one reads as absent', () => {
  const session = { ...decide, interactive: true, lens: /** @type {const} */ ('technical') }
  assert.deepEqual(Ask.parse(session), session)
  assert.equal(Ask.parse({ ...session, lens: 'product' }).lens, 'product')
  // Missing or unknown where required: the ask is invalid, so LenientAsk drops it and askError says why.
  assert.equal(Ask.safeParse({ ...session, lens: undefined }).success, false)
  assert.match(askError({ ...session, lens: 'vibes' }) ?? '', /lens: an interactive decide ask needs a lens/)
  const dropped = TriageResult.parse({ verdict: 'needs-human', reason: 'r', ask: { ...session, lens: 'vibes' } })
  assert.equal(dropped.ask, undefined)
  // Not required: an unknown lens is dropped and the ask kept.
  const plain = Ask.parse({ ...decide, lens: 'vibes' })
  assert.equal(plain.lens, undefined)
  assert.equal(plain.question, decide.question)
  assert.equal(Ask.parse({ kind: 'chore', question: 'q', interactive: true }).lens, undefined)
})

test('a valid lens survives the round trip through the state marker', () => {
  const ask = { ...decide, interactive: true, lens: /** @type {const} */ ('product') }
  const body = renderMarker(newMarker({ graph: 'dispatch', phase: 'dispatch', node: 'to-human', ask }))
  assert.deepEqual(parseMarker(body)?.ask, ask)
  assert.match(body, /\*\*Lens:\*\* product/)
})
