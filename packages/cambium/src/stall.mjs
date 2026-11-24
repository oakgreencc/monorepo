// @ts-check
/**
 * The stalled-queue fallback (upkeep.mjs, every `stall.everyMinutes`): what to do when a queue stops moving because
 * of a glitch or a circular dependency. Deterministic: no worker decides anything here. It replaces the daily
 * re-triage of the whole `q:human` queue. Per repo, in order:
 *
 * 1. **Orphan blocker:** a `wait:blocked` issue whose GitHub `blockedBy` issues are all closed, still parked
 *    `stall.graceMinutes` after the last one closed, is unparked back to triage (`start-triage`, no `wait:*`).
 * 2. **Overdue defer:** a `wait:deferred` issue still parked `stall.overdueMinutes` past its `deferUntil` is
 *    unparked the same way.
 * 3. **Circular `blockedBy`:** a cycle among open issues' `blockedBy` links, or a parked `wait:blocked` issue (parked
 *    `graceMinutes`) whose chain of open blockers ends at a `q:human` issue. Each is reported once: one `q:human`
 *    issue ({@link STALL_LABEL}) that names it, closed once it is gone. Same pattern as `red-base` and `watch`.
 * 4. **Starved:** no `q:task`, nothing `running`, `q:intake` holding only `wait:blocked` / `wait:deferred` issues,
 *    and no PR merged for `stall.starvedHours`. One `warn` event when it starts, one `info` when it ends; the
 *    heartbeat carries it while it holds (`repos[].stall.starved`).
 * 5. **Re-triage, narrowly:** only the `q:human` issues involved in a cycle, a chain or a starvation (the cycle's
 *    members, the issues the parked ones wait on), and only those whose triage inputs changed since triage answered
 *    needs-human (triage-inputs.mjs). Never the whole `q:human` queue; never one whose inputs are unchanged.
 *
 * State lives in the store (`stall:<repo>`), so a restart neither re-reports nor forgets an open issue.
 */
import { dispatch } from './graphs/dispatch.mjs'
import { iso, key, markerOf, MIN, setLabels, setMarker } from './issue-state.mjs'
import { move, Q, RUNNING, STALL_LABEL, WAIT, WHY } from './labels.mjs'
import { withHistory } from './marker.mjs'
import { each } from './tick.mjs'
import { retriageDecision } from './triage-inputs.mjs'

/**
 * @typedef {import('./tick.mjs').Deps} Deps
 * @typedef {import('./tick.mjs').Ctx} Ctx
 * @typedef {import('./github.mjs').Issue} Issue
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {{ everyMinutes: number, starvedHours: number, graceMinutes: number, overdueMinutes: number }} StallConfig
 * @typedef {{ key: string, kind: 'cycle' | 'human', members: number[], end: number | null, issue: number | null }} Loop
 *   `cycle`: `members` block each other in a ring. `human`: the parked `members` wait, through open blockers, on
 *   `end`, which is in `q:human`. `issue`: the report cambium opened (null until one opens).
 * @typedef {{ since: string, parked: number[], lastMergeAt: string | null }} Starved
 * @typedef {{ checkedAt: string | null, starved: Starved | null, loops: Loop[] }} StallState
 */

export { STALL_LABEL }

const HOUR = 60 * MIN

/** @param {string} slug */
export const stallKey = (slug) => `stall:${slug}`

/** @returns {StallState} */
const empty = () => ({ checkedAt: null, starved: null, loops: [] })

/** The stored state, as the heartbeat shows it. @param {import('./store.mjs').Store} store @param {string} slug */
export function stallState(store, slug) {
  try {
    return /** @type {StallState} */ ({ ...empty(), ...JSON.parse(store.get(stallKey(slug)) ?? 'null') })
  } catch {
    return empty()
  }
}

const open = (/** @type {Issue | undefined} */ i) => i?.state === 'OPEN'
const parked = (/** @type {Issue} */ i) =>
  open(i) && i.labels.includes(Q.intake) && (i.labels.includes(WAIT.blocked) || i.labels.includes(WAIT.deferred))

/**
 * When a parked issue started waiting for nothing, or null if it still waits. Pure.
 * - `wait:blocked` with every `blockedBy` closed (or none left): the last close, else when it parked.
 * - `wait:deferred`: its `deferUntil`, else when it parked.
 * @param {Issue} issue @returns {{ kind: 'orphan' | 'overdue', since: number } | null}
 */
export function idleSince(issue) {
  const m = issue.stateComment?.marker
  const entered = Date.parse(m?.enteredAt ?? '') || Date.parse(issue.createdAt)
  if (issue.labels.includes(WAIT.blocked)) {
    const blockers = issue.blockedBy ?? []
    if (blockers.some((b) => b.state === 'OPEN')) return null
    const closed = blockers.map((b) => Date.parse(b.closedAt ?? '')).filter(Number.isFinite)
    return { kind: 'orphan', since: closed.length ? Math.max(entered, ...closed) : entered }
  }
  if (issue.labels.includes(WAIT.deferred)) {
    const until = Date.parse(m?.deferUntil ?? '')
    return { kind: 'overdue', since: Number.isFinite(until) ? until : entered }
  }
  return null
}

/** The open issues `issue` waits on that the snapshot holds open. @param {Snapshot} snap @param {Issue} issue */
const edges = (snap, issue) =>
  (issue.blockedBy ?? []).filter((b) => b.state === 'OPEN' && open(snap.issues.get(b.number))).map((b) => b.number)

/**
 * The blocked-by loops in a snapshot. Pure.
 * - Cycles: strongly connected sets of open issues over open `blockedBy` links (Tarjan), of two or more issues or
 *   one that blocks itself.
 * - Chains: each `wait:blocked` issue parked `graceMs` or longer whose open blockers lead to a `q:human` issue,
 *   grouped by that issue.
 * @param {Snapshot} snap @param {{ now: number, graceMs: number }} o @returns {Omit<Loop, 'issue'>[]}
 */
export function loopsOf(snap, { now, graceMs }) {
  const nodes = [...snap.issues.values()].filter(open)
  /** @type {Map<number, number[]>} */
  const out = new Map(nodes.map((i) => [i.number, edges(snap, i)]))
  /** @type {Omit<Loop, 'issue'>[]} */
  const loops = []

  // Tarjan's strongly connected components.
  let index = 0
  /** @type {Map<number, { index: number, low: number, on: boolean }>} */
  const seen = new Map()
  /** @type {number[]} */
  const stack = []
  /** @param {number} v */
  const strong = (v) => {
    const s = { index, low: index, on: true }
    index++
    seen.set(v, s)
    stack.push(v)
    for (const w of out.get(v) ?? []) {
      const t = seen.get(w)
      if (!t) {
        strong(w)
        s.low = Math.min(s.low, /** @type {any} */ (seen.get(w)).low)
      } else if (t.on) s.low = Math.min(s.low, t.index)
    }
    if (s.low !== s.index) return
    /** @type {number[]} */
    const scc = []
    for (;;) {
      const w = /** @type {number} */ (stack.pop())
      const t = /** @type {{ on: boolean }} */ (seen.get(w))
      t.on = false
      scc.push(w)
      if (w === v) break
    }
    if (scc.length > 1 || (out.get(v) ?? []).includes(v)) {
      scc.sort((a, b) => a - b)
      loops.push({ key: `cycle:${scc.join(',')}`, kind: 'cycle', members: scc, end: null })
    }
  }
  for (const n of [...out.keys()].sort((a, b) => a - b)) if (!seen.has(n)) strong(n)

  // Chains from a parked issue to a q:human one.
  /** @type {Map<number, Set<number>>} */
  const byEnd = new Map()
  for (const i of nodes) {
    if (!i.labels.includes(Q.intake) || !i.labels.includes(WAIT.blocked)) continue
    const entered = Date.parse(i.stateComment?.marker?.enteredAt ?? '') || Date.parse(i.createdAt)
    if (now - entered < graceMs) continue
    /** @type {Set<number>} */
    const visited = new Set([i.number])
    const todo = [...(out.get(i.number) ?? [])]
    while (todo.length) {
      const n = /** @type {number} */ (todo.pop())
      if (visited.has(n)) continue
      visited.add(n)
      const b = /** @type {Issue} */ (snap.issues.get(n))
      if (b.labels.includes(Q.human)) {
        const set = byEnd.get(n) ?? new Set()
        set.add(i.number)
        byEnd.set(n, set)
        continue
      }
      todo.push(...(out.get(n) ?? []))
    }
  }
  for (const [end, starts] of [...byEnd].sort((a, b) => a[0] - b[0]))
    loops.push({ key: `human:${end}`, kind: 'human', members: [...starts].sort((a, b) => a - b), end })
  return loops
}

/** The newest merge the snapshot shows, or null. @param {Snapshot} snap */
export const lastMergeOf = (snap) => {
  const at = snap.prs
    .filter((p) => p.state === 'MERGED')
    .map((p) => Date.parse(p.mergedAt ?? p.updatedAt ?? ''))
    .filter(Number.isFinite)
  return at.length ? Math.max(...at) : null
}

/**
 * Starved, or null. Pure. @param {Snapshot} snap
 * @param {{ now: number, starvedMs: number, workers: number }} o @returns {Omit<Starved, 'since'> | null}
 */
export function starvedOf(snap, { now, starvedMs, workers }) {
  if (workers > 0) return null
  const live = [...snap.issues.values()].filter(open)
  if (live.some((i) => i.labels.includes(Q.task) || i.labels.includes(RUNNING))) return null
  const intake = live.filter((i) => i.labels.includes(Q.intake))
  if (!intake.length || !intake.every(parked)) return null
  const last = lastMergeOf(snap)
  if (last !== null && now - last < starvedMs) return null
  return { parked: intake.map((i) => i.number).sort((a, b) => a - b), lastMergeAt: last === null ? null : iso(last) }
}

/** @param {string} slug @param {Omit<Loop, 'issue'>} l */
const reportTitle = (slug, l) =>
  l.kind === 'cycle'
    ? `Stalled: ${[...l.members, l.members[0]].map((n) => `#${n}`).join(' → ')} block each other in ${slug}`
    : `Stalled: ${l.members.map((n) => `#${n}`).join(', ')} wait on #${l.end}, which is in q:human, in ${slug}`

/** @param {Omit<Loop, 'issue'>} l */
function reportBody(l) {
  const list = l.members.map((n) => `- #${n}`)
  const what =
    l.kind === 'cycle'
      ? [
          'These open issues block each other through GitHub "blocked by" links, so none of them can start:',
          '',
          ...list,
        ]
      : [
          `These parked issues wait, through GitHub "blocked by" links, on #${l.end}, which is in \`q:human\`:`,
          '',
          ...list,
          '',
          `Nothing moves until #${l.end} is answered or closed.`,
        ]
  return [
    ...what,
    '',
    l.kind === 'cycle'
      ? 'Remove one "blocked by" link, or close one of them, to break the cycle.'
      : `Answer or close #${l.end}, or remove the "blocked by" links that wait on it.`,
    '',
    'Opened by cambium because the queue stalled. cambium closes this issue once the loop is gone.',
  ].join('\n')
}

/**
 * One `q:human` report for a loop; `q:human` alone when the repo has no {@link STALL_LABEL} label. null when neither
 * works (logged), so the next check tries again.
 * @param {Deps} deps @param {string} slug @param {Omit<Loop, 'issue'>} l
 */
async function openReport(deps, slug, l) {
  const issue = { title: reportTitle(slug, l), body: reportBody(l) }
  for (const labels of [[Q.human, STALL_LABEL], [Q.human]])
    try {
      return (await deps.github.createIssue(slug, { ...issue, labels })).number
    } catch (err) {
      const msg = /** @type {Error} */ (err)?.message ?? String(err)
      if (labels.length > 1 && /does not exist|not found/i.test(msg)) continue
      deps.log('error', `stall: opening an issue: ${msg}`, { repo: slug })
      return null
    }
  return null
}

/**
 * Back to triage: the dispatch graph's entry node, the marker's context (defer reason, blockers, counts) kept so
 * the next triage sees why it waited, and no `wait:*` label.
 * @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Issue} issue @param {string} reason
 */
async function unpark(deps, ctx, slug, issue, reason) {
  const m = markerOf(issue)
  const at = iso(ctx.now)
  await setMarker(deps, slug, issue, {
    ...withHistory(m, { at, attempt: m.attempt, outcome: 'unpark', reason }),
    graph: dispatch.name,
    graphVersion: dispatch.version,
    phase: 'dispatch',
    node: dispatch.entry.node,
    status: 'waiting',
    enteredAt: at,
    deferUntil: null,
    input: null,
    host: null,
    start: null,
  })
  await setLabels(deps, slug, issue, move(issue.labels, Q.intake))
  ctx.touched.add(key(slug, issue.number))
  deps.log('info', `stall: unparked to triage: ${reason}`, { repo: slug, issue: issue.number })
}

/**
 * The stall step: due every `stall.everyMinutes` (0: off).
 * @param {Deps} deps @param {Ctx} ctx
 */
export async function stall(deps, ctx) {
  const { everyMinutes } = deps.config.stall
  const last = Number(deps.store.get('stall.lastRun') ?? 0)
  if (!everyMinutes || ctx.now - last < everyMinutes * MIN) return
  deps.store.set('stall.lastRun', String(ctx.now))
  for (const [slug, snap] of ctx.snaps)
    try {
      await checkRepo(deps, ctx, slug, snap)
    } catch (err) {
      deps.log('error', `stall: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: slug })
    }
}

/** @param {Deps} deps @param {Ctx} ctx @param {string} slug @param {Snapshot} snap */
async function checkRepo(deps, ctx, slug, snap) {
  const { starvedHours, graceMinutes, overdueMinutes } = deps.config.stall
  const prev = stallState(deps.store, slug)
  const busy = (/** @type {Issue} */ i) =>
    i.labels.includes(RUNNING) || Boolean(deps.store.worker(slug, i.number)) || ctx.touched.has(key(slug, i.number))

  // 1, 2: unpark what waits for nothing.
  await each(
    deps,
    [...snap.issues.values()].filter((i) => parked(i) && !busy(i)),
    async (issue) => {
      const idle = idleSince(issue)
      if (!idle) return
      const margin = (idle.kind === 'orphan' ? graceMinutes : overdueMinutes) * MIN
      if (ctx.now - idle.since < margin) return
      const reason =
        idle.kind === 'orphan'
          ? `wait:blocked, but every blocker is closed (since ${iso(idle.since)})`
          : `wait:deferred, but its recheck was due at ${iso(idle.since)}`
      await unpark(deps, ctx, slug, issue, reason)
    },
    (issue) => ({ repo: slug, issue: issue.number }),
  )

  // 3: report each loop once; close the reports of loops that are gone.
  const found = loopsOf(snap, { now: ctx.now, graceMs: graceMinutes * MIN })
  const byKey = new Map(prev.loops.map((l) => [l.key, l]))
  /** @type {Loop[]} */
  const loops = []
  for (const l of found) {
    const had = byKey.get(l.key)
    byKey.delete(l.key)
    let issue = had?.issue ?? null
    if (issue === null) {
      issue = await openReport(deps, slug, l)
      deps.log('warn', `stall: ${reportTitle(slug, l)}${issue !== null ? `; opened #${issue}` : ''}`, {
        repo: slug,
        ...(issue !== null ? { issue } : {}),
      })
    }
    loops.push({ ...l, issue })
  }
  for (const gone of byKey.values()) {
    if (gone.issue === null) continue
    try {
      await deps.github.close(
        slug,
        gone.issue,
        `The loop is gone: ${gone.members.map((n) => `#${n}`).join(', ')} no longer ${gone.kind === 'cycle' ? 'block each other' : `wait on #${gone.end}`} (${iso(ctx.now)}).`,
        { reason: 'completed' },
      )
      const i = snap.issues.get(gone.issue)
      if (i) i.state = 'CLOSED'
      deps.log('info', `stall: loop ${gone.key} is gone; closed #${gone.issue}`, { repo: slug, issue: gone.issue })
    } catch (err) {
      deps.log('error', `stall: closing #${gone.issue}: ${/** @type {Error} */ (err)?.message ?? err}`, { repo: slug })
      loops.push(gone)
    }
  }

  // 4: starvation, once on, once off.
  const workers = deps.store.workers().filter((w) => w.repo === slug).length
  const s = starvedOf(snap, { now: ctx.now, starvedMs: starvedHours * HOUR, workers })
  /** @type {Starved | null} */
  const starved = s ? { since: prev.starved?.since ?? iso(ctx.now), ...s } : null
  if (starved && !prev.starved)
    deps.log(
      'warn',
      `stall: queue starved: no q:task, nothing running, q:intake only parked (${starved.parked.map((n) => `#${n}`).join(', ')}), ` +
        `no merge since ${starved.lastMergeAt ?? 'the newest the snapshot shows'}`,
      { repo: slug },
    )
  else if (!starved && prev.starved) deps.log('info', `stall: queue moving again`, { repo: slug })

  deps.store.set(stallKey(slug), JSON.stringify({ checkedAt: iso(ctx.now), starved, loops }))

  // 5: re-triage only the q:human issues involved, only when their inputs changed.
  /** @type {Set<number>} */
  const involved = new Set()
  for (const l of loops) {
    if (l.end !== null) involved.add(l.end)
    if (l.kind === 'cycle') for (const n of l.members) involved.add(n)
  }
  if (starved)
    for (const n of starved.parked) {
      const i = snap.issues.get(n)
      for (const b of i ? edges(snap, i) : []) involved.add(b)
    }
  const reports = new Set(loops.map((l) => l.issue))
  const o = { botLogin: deps.config.graft.botLogin }
  const human = [...involved]
    .map((n) => snap.issues.get(n))
    .filter(
      (i) =>
        !!i &&
        open(i) &&
        i.labels.includes(Q.human) &&
        !i.labels.includes(WHY.approve) &&
        !reports.has(i.number) &&
        !busy(i),
    )
  await each(
    deps,
    /** @type {Issue[]} */ (human),
    async (issue) => {
      const d = retriageDecision(issue, snap, o)
      if (!d.retriage) return
      await setLabels(deps, slug, issue, move(issue.labels, Q.intake))
      ctx.touched.add(key(slug, issue.number))
      deps.log('info', `stall: re-triage: its triage inputs changed; q:human → q:intake`, {
        repo: slug,
        issue: issue.number,
      })
    },
    (issue) => ({ repo: slug, issue: issue.number }),
  )
}
