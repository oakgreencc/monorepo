// @ts-check
/**
 * Fakes for the tick: a stateful GitHub (labels, one state comment per issue
 * rendered and re-parsed through the real marker code, PRs), a clock, a
 * spawner and a process table. Not a test file.
 */
import { resolveConfig } from '../src/config.mjs'
import { resolveConvention } from '../src/convention.mjs'
import { parseDecideMarker } from '../src/graphs/decide.mjs'
import { parseMarker } from '../src/marker.mjs'
import { openStore } from '../src/store.mjs'

export const SLUG = 'o/r'

/** The last comment holding a `cambium:decide` marker, as github.mjs reads it. @param {{ id?: number, body: string }[]} comments */
const decideCommentOf = (comments) => {
  const c = comments.findLast((x) => parseDecideMarker(x.body))
  return c ? { id: c.id ?? 0, marker: /** @type {any} */ (parseDecideMarker(c.body)) } : null
}
export const T0 = Date.parse('2026-11-16T12:00:00Z')

/**
 * @typedef {{ number: number, title?: string, state?: 'OPEN' | 'CLOSED', createdAt?: string, body?: string,
 *   labels?: string[], comment?: { id: number, body: string } | null,
 *   blockedBy?: import('../src/github.mjs').Blocker[], comments?: import('../src/github.mjs').Comment[] }} FakeIssue
 *   `blockedBy`: a blocker that is also an issue here reads with that issue's state. `comments`: the recent comments
 *   `read` returns (the state comment is kept apart, in `comment`).
 * @typedef {Partial<import('../src/github.mjs').PullRequest> & { number: number, closes: number[], behind?: number }} FakePr
 *   `behind`: commits of its base the head lacks (`behindBase`); `updatePull` zeroes it and moves the head.
 */

/** cambium's PRs: an `agent/` branch. @param {{ branch: string }} p */
const isAgent = (p) => p.branch.startsWith('agent/')

/** @param {{ issues?: FakeIssue[], prs?: FakePr[] }} [seed] */
export function fakeGitHub({ issues = [], prs = [] } = {}) {
  /** @type {Map<number, Required<FakeIssue>>} */
  const store = new Map()
  for (const i of issues)
    store.set(i.number, {
      title: `Issue ${i.number}`,
      state: 'OPEN',
      createdAt: new Date(T0 - (1000 - i.number) * 60_000).toISOString(),
      body: `Body of ${i.number}`,
      labels: [],
      comment: null,
      blockedBy: [],
      comments: [],
      ...i,
    })
  /** @type {import('../src/github.mjs').PullRequest[]} */
  const pulls = prs.map((p) => ({
    url: `https://github.com/${SLUG}/pull/${p.number}`,
    branch: `agent/issue-${p.closes[0]}`,
    state: 'OPEN',
    headSha: 'sha1aaaaaaa',
    branchExists: true,
    inMergeQueue: false,
    autoMerge: true,
    checks: 'PENDING',
    failing: [],
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    createdAt: new Date(T0).toISOString(),
    ...p,
  }))
  /** @type {{ op: string, args: any[] }[]} */
  const calls = []
  let nextComment = 1000
  /** When set, the next `writeState` of a `cambium:decide` marker throws it (once): a crash before the write. @type {{ decideWrite: Error | null }} */
  const crash = { decideWrite: null }
  /** The time new comments are created at (tests that post comments set it to their clock). */
  const commentClock = { now: () => T0 }
  /** cambium's own comments: a decide marker is a comment of its own, as on GitHub (the state comment is apart). */
  const own = (/** @type {Required<FakeIssue>} */ i, /** @type {number | null} */ id, /** @type {string} */ body) => {
    const c = i.comments.find((x) => x.id === id)
    if (c) c.body = body
    else
      i.comments.push({
        id: id ?? nextComment++,
        author: 'cambium[bot]',
        bot: true,
        createdAt: new Date(commentClock.now()).toISOString(),
        body,
      })
    return /** @type {number} */ (c?.id ?? i.comments.at(-1)?.id)
  }
  /**
   * `missingLabels`: labels the repo lacks; adding one is refused as graft refuses it.
   * @type {{ readError: Error | null, labelError: Error | null, hang: boolean, mergeError: Error | null, updateError: Error | null, runsError: Error | null, rulesError: Error | null, missingLabels: Set<string> }}
   */
  const faults = {
    readError: null,
    labelError: null,
    hang: false,
    mergeError: null,
    updateError: null,
    runsError: null,
    rulesError: null,
    missingLabels: new Set(),
  }
  /**
   * The base's health `read` reports (base-health.mjs), or null for none; `repairs` is filled from the open
   * issues labelled `red-base`, as the real query does.
   * `rateLimit`: the GraphQL budget `read` reports, or null.
   * @type {{ base: Omit<import("../src/base-health.mjs").BaseHealth, "repairs"> | null, rateLimit: { cost: number, remaining: number, resetAt: string } | null }}
   */
  const health = { base: null, rateLimit: null }
  /** Workflow runs by `<workflow>@<branch>`, newest first (watch.mjs). @type {Map<string, import("../src/watch.mjs").WorkflowRun[]>} */
  const runs = new Map()
  /** The rules `mergeRules` reports, by base branch; a base not here has none. @type {Map<string, import("../src/github.mjs").MergeRules>} */
  const rules = new Map()
  let nextIssue = 9000

  const toIssue = (/** @type {Required<FakeIssue>} */ i) => ({
    number: i.number,
    title: i.title,
    url: `https://github.com/${SLUG}/issues/${i.number}`,
    state: i.state,
    createdAt: i.createdAt,
    body: i.body,
    labels: [...i.labels],
    stateComment: i.comment ? { id: i.comment.id, marker: /** @type {any} */ (parseMarker(i.comment.body)) } : null,
    blockedBy: i.blockedBy.map((b) => {
      const s = store.get(b.number)
      return s ? { ...b, state: s.state, closedAt: s.state === 'CLOSED' ? b.closedAt : null } : { ...b }
    }),
    comments: i.comments.map((c) => ({ ...c })),
    decideComment: decideCommentOf(i.comments),
  })

  /** @type {import('../src/github.mjs').GitHub} */
  const github = {
    async read(slug) {
      calls.push({ op: 'read', args: [slug] })
      if (faults.hang) await new Promise(() => {})
      if (faults.readError) throw faults.readError
      const issuesOut = new Map()
      for (const i of store.values())
        if (i.state === 'OPEN' && i.labels.some((l) => l.startsWith('q:'))) issuesOut.set(i.number, toIssue(i))
      for (const p of pulls)
        for (const n of p.closes)
          if (store.has(n) && !issuesOut.has(n)) issuesOut.set(n, toIssue(/** @type {any} */ (store.get(n))))
      const repairs = [...store.values()]
        .filter((i) => i.state === 'OPEN' && i.labels.includes('red-base'))
        .map((i) => i.number)
      // The search the real read makes while `intake.adopt` is on: open, in no queue, no lease, oldest first.
      const unqueued = [...store.values()]
        .filter((i) => i.state === 'OPEN' && !issuesOut.has(i.number))
        .filter((i) => !i.labels.some((l) => l.startsWith('q:') || l === 'running'))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(toIssue)
      return {
        issues: issuesOut,
        unqueued,
        prs: pulls.filter(isAgent).map((p) => ({ ...p, closes: [...p.closes], failing: [...p.failing] })),
        // The real read keeps only `agent/*` PRs in `prs`; another open one with auto-merge armed is in `armed`.
        armed: pulls.filter((p) => !isAgent(p) && p.state === 'OPEN' && p.autoMerge).map((p) => ({ ...p })),
        ...(health.base ? { base: { ...health.base, suspects: [...health.base.suspects], repairs } } : {}),
        rateLimit: health.rateLimit,
      }
    },
    async label(slug, number, { add, remove }) {
      calls.push({ op: 'label', args: [slug, number, { add, remove }] })
      if (faults.labelError) throw faults.labelError
      const missing = add.find((l) => faults.missingLabels.has(l))
      if (missing) throw new Error(`graft issue exited 1: refusing: label '${missing}' does not exist in ${slug}`)
      const i = /** @type {Required<FakeIssue>} */ (store.get(number))
      i.labels = [...i.labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !i.labels.includes(l))]
    },
    async writeState(slug, number, commentId, body) {
      calls.push({ op: 'writeState', args: [slug, number, commentId, body] })
      const i = /** @type {Required<FakeIssue>} */ (store.get(number))
      if (parseDecideMarker(body)) {
        if (crash.decideWrite) {
          const err = crash.decideWrite
          crash.decideWrite = null
          throw err
        }
        return own(i, commentId, body)
      }
      if (commentId && i.comment?.id !== commentId) throw new Error(`no comment ${commentId}`)
      const id = commentId ?? nextComment++
      i.comment = { id, body }
      return id
    },
    async close(slug, number, body, opts) {
      calls.push({ op: 'close', args: opts ? [slug, number, body, opts] : [slug, number, body] })
      const i = /** @type {Required<FakeIssue>} */ (store.get(number))
      i.state = 'CLOSED'
    },
    async createIssue(slug, { title, body, labels }) {
      calls.push({ op: 'createIssue', args: [slug, { title, body, labels }] })
      const missing = labels.find((l) => faults.missingLabels.has(l))
      if (missing) throw new Error(`graft issue exited 1: refusing: label '${missing}' does not exist in ${slug}`)
      const number = nextIssue++
      store.set(number, {
        number,
        title,
        state: 'OPEN',
        createdAt: new Date(T0).toISOString(),
        body,
        labels: [...labels],
        comment: null,
        blockedBy: [],
        comments: [],
      })
      return { number, url: `https://github.com/${slug}/issues/${number}` }
    },
    async comment(slug, number, body) {
      calls.push({ op: 'comment', args: [slug, number, body] })
      if (/<!-- cambium:decide-post /.test(body) || /<!-- cambium:answer /.test(body))
        own(/** @type {Required<FakeIssue>} */ (store.get(number)), null, body)
    },
    async deleteBranch(slug, branch) {
      calls.push({ op: 'deleteBranch', args: [slug, branch] })
      for (const p of pulls) if (p.branch === branch) p.branchExists = false
    },
    async closePull(slug, number, comment) {
      calls.push({ op: 'closePull', args: [slug, number, comment] })
      const p = pulls.find((x) => x.number === number)
      if (p) p.state = 'CLOSED'
    },
    async mergePull(slug, number) {
      calls.push({ op: 'mergePull', args: [slug, number] })
      if (faults.mergeError) throw faults.mergeError
    },
    async workflowRuns(slug, workflow, branch) {
      calls.push({ op: 'workflowRuns', args: [slug, workflow, branch] })
      if (faults.runsError) throw faults.runsError
      return [...(runs.get(`${workflow}@${branch}`) ?? [])]
    },
    async mergeRules(slug, base) {
      calls.push({ op: 'mergeRules', args: [slug, base] })
      if (faults.rulesError) throw faults.rulesError
      return rules.get(base) ?? { requiredChecks: [], approvals: 0, codeOwners: false, rulesets: [] }
    },
    async mergeCommit(slug, number) {
      calls.push({ op: 'mergeCommit', args: [slug, number] })
      const p = pulls.find((x) => x.number === number)
      return p?.state === 'MERGED' ? `merge-${number}` : null
    },
    async behindBase(slug, number) {
      calls.push({ op: 'behindBase', args: [slug, number] })
      const p = /** @type {any} */ (pulls.find((x) => x.number === number))
      return { behind: p?.behind ?? 0, base: 'develop' }
    },
    async updatePull(slug, number) {
      calls.push({ op: 'updatePull', args: [slug, number] })
      if (faults.updateError) throw faults.updateError
      const p = /** @type {any} */ (pulls.find((x) => x.number === number))
      Object.assign(p, { behind: 0, headSha: `${p.headSha}+base`, checks: 'PENDING' })
    },
    async addBlockedBy(slug, number, blocker) {
      calls.push({ op: 'addBlockedBy', args: [slug, number, blocker] })
      const b = store.get(blocker)
      if (!b) throw new Error(`no issue #${blocker}`)
      const i = /** @type {Required<FakeIssue>} */ (store.get(number))
      if (!i.blockedBy.some((x) => x.number === blocker))
        i.blockedBy.push({ number: blocker, state: b.state, closedAt: null })
      return { state: b.state }
    },
    async closedPulls(slug) {
      calls.push({ op: 'closedPulls', args: [slug] })
      return pulls.filter((p) => p.state === 'CLOSED').map((p) => ({ ...p, closes: [...p.closes] }))
    },
    async readIssues(slug, numbers) {
      calls.push({ op: 'readIssues', args: [slug, [...numbers]] })
      const out = new Map()
      for (const n of numbers) if (store.has(n)) out.set(n, toIssue(/** @type {any} */ (store.get(n))))
      return out
    },
    async linkIssue(slug, pr, issue) {
      calls.push({ op: 'linkIssue', args: [slug, pr, issue] })
      const p = pulls.find((x) => x.number === pr)
      if (p && !p.closes.includes(issue)) p.closes.push(issue)
    },
  }
  return {
    github,
    calls,
    faults,
    crash,
    commentClock,
    health,
    runs,
    rules,
    pulls,
    issue: (/** @type {number} */ n) => /** @type {Required<FakeIssue>} */ (store.get(n)),
    marker: (/** @type {number} */ n) => parseMarker(store.get(n)?.comment?.body),
    /** @param {FakePr} p */
    addPr(p) {
      pulls.push({
        url: `https://github.com/${SLUG}/pull/${p.number}`,
        branch: `agent/issue-${p.closes[0]}`,
        state: 'OPEN',
        headSha: 'sha1aaaaaaa',
        branchExists: true,
        inMergeQueue: false,
        autoMerge: true,
        checks: 'PENDING',
        failing: [],
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        createdAt: new Date(T0).toISOString(),
        ...p,
      })
    },
    pr: (/** @type {number} */ n) =>
      /** @type {import('../src/github.mjs').PullRequest} */ (pulls.find((p) => p.number === n)),
  }
}

export function fakeClock(t = T0) {
  return {
    t,
    now() {
      return this.t
    },
    advance(/** @type {number} */ ms) {
      this.t += ms
    },
  }
}

export function fakeProcs() {
  const alive = new Set()
  /** @type {number[]} */
  const killed = []
  /** @type {number[]} */
  const terminated = []
  /** Pids that ignore SIGTERM (a wedged worker); every other pid exits on it, as Claude Code does. */
  const stubborn = new Set()
  return {
    alive: (/** @type {number} */ pid) => alive.has(pid),
    terminate(/** @type {number} */ pid) {
      terminated.push(pid)
      if (!stubborn.has(pid)) alive.delete(pid)
    },
    kill(/** @type {number} */ pid) {
      killed.push(pid)
      alive.delete(pid)
    },
    live: alive,
    killed,
    terminated,
    stubborn,
  }
}

/** @param {ReturnType<typeof fakeProcs>} procs */
export function fakeSpawner(procs) {
  let pid = 5000
  /** @type {(import('../src/workers.mjs').StartSpec & { prompt: string })[]} */
  const started = []
  /** @type {string[]} */
  const cleaned = []
  const s = {
    fail: /** @type {Error | null} */ (null),
    /** The target repo's raw `"cambium"` key; resolved (and validated) on every start. */
    pkgCambium: /** @type {unknown} */ (undefined),
    /** Set → cleanup keeps the worktree with this reason. */
    keep: /** @type {string | null} */ (null),
    started,
    cleaned,
    /** @param {import('../src/config.mjs').Repo} repo */
    convention(repo) {
      return resolveConvention(s.pkgCambium, repo.path)
    },
    /** @param {import('../src/workers.mjs').StartSpec} spec */
    async start(spec) {
      if (s.fail) throw s.fail
      const p = ++pid
      procs.live.add(p)
      const prompt = spec.buildPrompt('# AGENTS.md from the worktree')
      started.push({ ...spec, prompt })
      const base = `/logs/o__r/issue-${spec.issue}/a${spec.attempt}`
      return {
        pid: p,
        worktree: `${spec.convention.root}/${spec.branch.replace(/^[^/]+\//, '')}`,
        stdout: `${base}.out.log`,
        stderr: `${base}.err.log`,
        prompt: `${base}.prompt.md`,
        exited: Promise.resolve(0),
        reused: null,
      }
    },
    /** @param {{ worktree: string, readOnly?: boolean }} w */
    async cleanup(w) {
      if (s.keep && !w.readOnly) return { removed: false, reason: s.keep }
      cleaned.push(w.worktree)
      return { removed: true, reason: null }
    },
    stderrTail: 'Error: the last stderr line',
    tail: () => s.stderrTail,
    /** Worker stdout logs by path, for workers whose output cambium reads (triage). */
    logs: /** @type {Map<string, string>} */ (new Map()),
    /** @param {string} path */
    readLog: (path) => s.logs.get(path) ?? '',
  }
  return s
}

/**
 * @param {{ issues?: FakeIssue[], prs?: FakePr[], config?: any, store?: import('../src/store.mjs').Store }} [seed]
 */
export function harness({ issues, prs, config: raw = {}, store } = {}) {
  const config = resolveConfig({
    host: 'mac',
    stepTimeoutSeconds: 5,
    repos: [{ slug: SLUG, path: '/repo' }],
    paths: { home: '/nonexistent-cambium-home' },
    ...raw,
  })
  const gh = fakeGitHub({ issues, prs })
  const clock = fakeClock()
  const procs = fakeProcs()
  const spawner = fakeSpawner(procs)
  /** @type {import('../src/tick.mjs').Event[]} */
  const events = []
  /** @type {import('../src/tick.mjs').HeartbeatState[]} */
  const beats = []
  /** @type {import('../src/tick.mjs').Deps} */
  const deps = {
    config,
    clock,
    github: gh.github,
    store: store ?? openStore(':memory:'),
    spawner,
    procs,
    log: (level, msg, where = {}) => events.push({ at: new Date(clock.now()).toISOString(), level, msg, ...where }),
    events: () => events,
    heartbeat: (s) => {
      beats.push(structuredClone(s))
    },
  }
  return { deps, gh, clock, procs, spawner, events, beats, config }
}

/** Both engines' nodes as the stage the legacy tick names. @type {Record<string, string>} */
const STAGE_OF = {
  'start-worker': 'queued',
  'worker-running': 'running',
  'ci-running': 'submitted',
  submit: 'submitted',
  merge: 'submitted',
  merging: 'submitted',
  'merge-queue': 'submitted',
  'to-human': 'human',
  'close-out': 'done',
}

/** The stage a marker is at, whichever engine wrote it. @param {import('../src/marker.mjs').Marker | null | undefined} m */
export const stageOf = (m) => (m ? STAGE_OF[m.node] : undefined)

/**
 * `merge-queue` is the legacy tick's `submitted` with `queued: true`, and the graph's `submit` (where the task graph
 * ends) is the legacy tick's `submitted`, so all compare as `ci-running`.
 * @param {string | null | undefined} node
 */
const sameNode = (node) => (node === 'merge-queue' || node === 'submit' ? 'ci-running' : node)

/**
 * A marker's meaning, without what only one engine writes: `stage` (legacy), `graphVersion`, `enteredAt` and
 * `input` (graph), and the rendered text around it.
 * @param {string} body
 */
export function semanticMarker(body) {
  const m = /** @type {Record<string, any>} */ (parseMarker(body))
  const { stage: _stage, graphVersion: _version, enteredAt: _entered, input: _input, ...rest } = m
  // The task graph ends at `submit` (done, no lease); the legacy tick's `submitted` waits there with its lease.
  const submitted = rest.node === 'submit'
  return {
    ...rest,
    ...(submitted ? { status: 'waiting' } : {}),
    node: sameNode(rest.node),
    history: rest.history.map((/** @type {any} */ h) => ({ ...h, node: sameNode(h.node) })),
  }
}

/**
 * What a harness saw, for the differential test: every GitHub call in order (label moves, markers compared
 * semantically, closes, branch deletions), worker starts with their prompts, kills, worktree teardowns, the
 * worker rows left, the log, and the heartbeats (without step timings, `engine`, or `repos[].stall`, which only the
 * graph engine's upkeep fills).
 * @param {ReturnType<typeof harness>} h
 */
export function trace(h) {
  /** @type {unknown[]} */
  let workers
  try {
    workers = h.deps.store.workers()
  } catch {
    workers = ['(store closed)']
  }
  return {
    calls: h.gh.calls.map((c) =>
      c.op === 'writeState'
        ? { op: c.op, issue: c.args[1], comment: c.args[2], marker: semanticMarker(c.args[3]) }
        : { op: c.op, args: c.args },
    ),
    starts: h.spawner.started.map(({ issue, attempt, branch, phase, maxTurns, foreground, prompt }) => ({
      issue,
      attempt,
      branch,
      phase,
      maxTurns,
      foreground,
      prompt,
    })),
    killed: [...h.procs.killed],
    cleaned: [...h.spawner.cleaned],
    workers,
    events: h.events.map((e) => ({ ...e })),
    // `engine` names the engine that ran, which is the one thing the two engines must differ on.
    beats: h.beats.map(({ engine: _engine, ...b }) => ({
      ...b,
      steps: b.steps.map(({ ms: _ms, ...s }) => s),
      repos: b.repos.map(({ stall: _stall, ...r }) => r),
    })),
  }
}
