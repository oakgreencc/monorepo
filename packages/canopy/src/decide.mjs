// @ts-check
// The Inbox reading pane's decide part: how to start or resume a decision (`/oakgreen:decide`) and how far it has
// got, from the `decide` summary cambium's queue view carries (cambium queue-view.mjs `decideOf`).
// The functions use nothing but each other and their arguments (no imports, no module state) because page.mjs embeds
// their source in the page with `toString()`; tests call them with a plain-object `h`.

/**
 * @typedef {{ status: 'none' | 'leased' | 'paused' | 'done', node: string | null, round: number,
 *   holder: string | null, outcome: 'answered' | 'abandoned' | null, answerUrl: string | null,
 *   lens: 'product' | 'technical' | null, at: string | null, error: string | null }} DecideSummary
 * @typedef {{ text: string, detail: string[], cls: string }} DecideStatus
 */

/**
 * A decision's status in words. With no summary (canopy read the queues from GitHub, not cambium's queue view) the
 * status is unknown, not "not started".
 *
 * @param {DecideSummary | null | undefined} d @returns {DecideStatus}
 */
export function decideStatus(d) {
  if (!d)
    return {
      text: 'Status unknown',
      detail: ["cambium's queue view carries it; canopy is reading GitHub"],
      cls: 'faint',
    }
  if (d.status === 'none') return { text: 'Not started', detail: ['no decision marker on the issue yet'], cls: 'muted' }
  if (d.status === 'paused')
    return {
      text: 'Paused',
      detail: [
        `idle at ${d.node || '?'}${d.round ? `, round ${d.round}` : ''}`,
        'a reply on the issue, or the command, resumes it',
      ],
      cls: 'warn',
    }
  if (d.status === 'done')
    return {
      text: d.outcome === 'abandoned' ? 'Abandoned' : 'Committed',
      detail: [d.outcome || 'done'],
      cls: d.outcome === 'abandoned' ? 'muted' : 'ok',
    }
  return {
    text: 'Live',
    detail: [
      `at ${d.node || '?'}`,
      `round ${d.round}`,
      d.holder ? `held by ${d.holder}` : 'no holder',
      ...(d.error ? [`last turn failed: ${d.error}`] : []),
    ],
    cls: 'ok',
  }
}

/**
 * The reading pane's decide part: the status, a link to the answer once committed, and the command with Copy.
 * `link(url, text)` makes the answer link (the page's: http(s) only).
 *
 * @param {{ decide?: DecideSummary | null, decideCommand: string }} it
 * @param {(tag: string, attrs: any, ...kids: any[]) => any} h
 * @param {(url: string | null, text: string) => any} link
 */
export function decidePart(it, h, link) {
  const d = it.decide
  const st = decideStatus(d)
  const done = d && d.status === 'done'
  return h(
    'div',
    { class: 'part session decide' },
    h('h3', {}, 'Decision', h('span', {}, d?.lens ? `lens: ${d.lens}` : '/oakgreen:decide')),
    h(
      'p',
      { class: 'decide-status' },
      h('b', { class: st.cls }, st.text),
      st.detail.map((x) => [' · ', h('span', { class: 'muted' }, x)]),
      done && d.answerUrl ? [' · ', link(d.answerUrl, 'the answer')] : null,
    ),
    h(
      'p',
      { class: 'muted' },
      done
        ? 'Decided. The command shows the outcome cambium recorded.'
        : d && d.status !== 'none'
          ? 'Resumes the decision in claude from where its marker stands.'
          : 'Starts claude in the repo on this decision: it researches, asks in rounds, and writes the answer back.',
    ),
    h(
      'div',
      { class: 'cmd' },
      h('code', { class: 'mono' }, it.decideCommand),
      h('button', { class: 'btn', type: 'button', 'data-copy': it.decideCommand, title: 'Copy the command' }, 'Copy'),
    ),
  )
}
