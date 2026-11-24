// @ts-check
// The Inbox list's model: which items, which filter tags they carry, and the order they are shown in.
// The functions use nothing but each other (no imports, no module state) because page.mjs embeds their source
// in the page with `toString()`; tests call them directly.

/**
 * @typedef {import('./queues.mjs').Item & { kind: 'human' | 'stranded' | 'cost', key: string, at: string | null,
 *   tags: string[], pr?: import('./queues.mjs').Stranded['pr'], cost?: import('./cost.mjs').ItemCost | null }} InboxItem
 *   `kind: 'cost'`: a session candidate, in the Inbox only because its task spend is over cambium's `costFlagUsd`
 *   with no merged PR (cost.mjs `withCosts`). `at` is the time the list sorts by: last update for `q:human`, the
 *   PR's close for a stranded issue, none for a session candidate. `tags` are filter ids, `<facet>:<value>`.
 * @typedef {{ id: string, value: string, n: number, on: boolean }} Tag
 * @typedef {{ facet: string, tags: Tag[] }} Facet
 * @typedef {'newest' | 'oldest' | 'priority'} Sort
 */

/**
 * `q:human` items, stranded issues and session candidates as one list, each with its filter tags. Facets: `kind`,
 * `flag` (`flag:cost` on any item over the cost threshold), `why`, `lens` (a decision's `product` or `technical`, from
 * cambium's queue view), `priority`, `repo`, and `label` for any other
 * label cambium's vocabulary doesn't already cover.
 *
 * @param {{ columns: { human: import('./queues.mjs').Item[] }, stranded?: import('./queues.mjs').Stranded[],
 *   flagged?: import('./queues.mjs').Item[] }} gh
 * @returns {InboxItem[]}
 */
export function inboxItems(gh) {
  const own = /^(q:|why:|priority:)|^running$/
  const tagsOf = (/** @type {any} */ i, /** @type {string} */ kind) => [
    `kind:${kind}`,
    ...(i.cost?.flagged ? ['flag:cost'] : []),
    ...(i.why ? [`why:${i.why}`] : []),
    ...(i.decide?.lens ? [`lens:${i.decide.lens}`] : []),
    ...(i.priority ? [`priority:${i.priority}`] : []),
    `repo:${i.repo}`,
    ...i.labels.filter((/** @type {string} */ l) => !own.test(l)).map((/** @type {string} */ l) => `label:${l}`),
  ]
  return [
    ...gh.columns.human.map((i) => ({
      ...i,
      kind: /** @type {const} */ ('human'),
      key: `${i.repo}#${i.number}`,
      at: i.updatedAt || i.createdAt,
      tags: tagsOf(i, 'human'),
    })),
    ...(gh.stranded || []).map((i) => ({
      ...i,
      kind: /** @type {const} */ ('stranded'),
      key: `${i.repo}#${i.number}`,
      at: i.pr.closedAt || i.updatedAt || i.createdAt,
      tags: tagsOf(i, 'stranded'),
    })),
    ...(gh.flagged || []).map((i) => ({
      ...i,
      kind: /** @type {const} */ ('cost'),
      key: `${i.repo}#${i.number}`,
      at: i.updatedAt || i.createdAt || null,
      tags: tagsOf(i, 'cost'),
    })),
  ]
}

/**
 * @typedef {{ id: string, label: string, hint: string, items: InboxItem[] }} Group
 */

/**
 * Which Inbox group an item is in, by its `why:*` and `ask:*` labels (cambium's ask.mjs): what answering it takes.
 * `approvals`: a merge only a person may make (`why:approve`, `ask:approve`). `session`: worth a live session
 * (`why:budget`, an interactive decision: `ask:decide` with `ask:session`, or a session candidate: task spend over
 * cambium's `costFlagUsd` with no merged PR). `comment`: any other decision.
 * `chores`: offline work or a check (`ask:verify`, `ask:chore`). `other`: no ask to go by. `stranded`: a closed PR.
 *
 * @param {InboxItem} it @returns {string}
 */
export function groupOf(it) {
  const has = (/** @type {string} */ l) => it.labels.includes(l)
  if (it.kind === 'stranded') return 'stranded'
  if (has('why:approve') || has('ask:approve')) return 'approvals'
  if (has('why:budget') || (has('ask:decide') && has('ask:session')) || it.cost?.flagged) return 'session'
  if (has('ask:decide')) return 'comment'
  if (has('ask:verify') || has('ask:chore')) return 'chores'
  return 'other'
}

/**
 * The items in their groups, in a fixed order, each keeping the order it was given in; empty groups are left out.
 *
 * @param {InboxItem[]} items @returns {Group[]}
 */
export function inboxGroups(items) {
  const GROUPS = [
    ['session', 'Needs a session', 'An interactive decision or a spent budget: sit down with the code'],
    ['comment', 'Answer in a comment', 'A decision cambium wrote up: reply with your choice'],
    ['chores', 'Offline chores', 'Checks and chores away from the keyboard: comment when done'],
    ['approvals', 'Approvals', 'A merge only a person may make'],
    ['other', 'Other', 'No ask to go by: read the state comment'],
    ['stranded', 'PR closed', 'Agent PR closed unmerged; the issue is in no queue'],
  ]
  return GROUPS.map(([id, label, hint]) => ({
    id,
    label,
    hint,
    items: items.filter((it) => groupOf(it) === id),
  })).filter((g) => g.items.length)
}

/** cambium's priorities, most urgent first; anything else sorts after them, and no priority last. */
export function priorityRank(/** @type {string | null | undefined} */ p) {
  const i = ['critical', 'high', 'medium', 'low'].indexOf(p || '')
  return i >= 0 ? i : p ? 4 : 5
}

/**
 * The tags worth offering: those that would narrow the list (a tag every item carries filters nothing), plus
 * any selected tag, kept even at zero matches so it can be cleared. Facets with nothing to offer are left out.
 *
 * @param {InboxItem[]} items
 * @param {Set<string>} selected
 * @returns {Facet[]}
 */
export function facetsOf(items, selected) {
  const order = ['kind', 'flag', 'why', 'lens', 'priority', 'repo', 'label']
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const it of items) for (const t of it.tags) counts.set(t, (counts.get(t) || 0) + 1)
  for (const t of selected) if (!counts.has(t)) counts.set(t, 0)
  /** @type {Facet[]} */
  const out = []
  for (const facet of order) {
    const tags = [...counts]
      .filter(([id, n]) => id.startsWith(`${facet}:`) && (selected.has(id) || n < items.length))
      .map(([id, n]) => ({ id, value: id.slice(facet.length + 1), n, on: selected.has(id) }))
    if (facet === 'priority') tags.sort((a, b) => priorityRank(a.value) - priorityRank(b.value))
    else if (facet !== 'kind') tags.sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
    if (tags.length) out.push({ facet, tags })
  }
  return out
}

/**
 * Filter, then sort. Selected tags in one facet widen (any of them); across facets they narrow (all facets).
 *
 * @param {InboxItem[]} items
 * @param {{ sort: Sort, tags: Set<string> }} view
 * @returns {InboxItem[]}
 */
export function viewOf(items, { sort, tags }) {
  /** @type {Map<string, string[]>} */
  const byFacet = new Map()
  for (const t of tags) {
    const f = t.slice(0, t.indexOf(':'))
    byFacet.set(f, [...(byFacet.get(f) || []), t])
  }
  const kept = items.filter((it) => [...byFacet.values()].every((any) => any.some((t) => it.tags.includes(t))))
  const time = (/** @type {InboxItem} */ it) => (it.at ? Date.parse(it.at) : 0) || 0
  const byTime = (/** @type {InboxItem} */ a, /** @type {InboxItem} */ b) => time(b) - time(a) || b.number - a.number
  return kept.sort(
    sort === 'oldest'
      ? (a, b) => -byTime(a, b)
      : sort === 'priority'
        ? (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || byTime(a, b)
        : byTime,
  )
}

/**
 * @typedef {{ key: string, label: string, n: number, tag: string | null }} Part
 *   One slice of the inbox; `tag` is the filter that selects it, when one exists.
 * @typedef {{ total: number, reasons: Part[], priorities: Part[], opened: Part[], oldest: string | null,
 *   repos: Part[] }} InboxStats
 */

/**
 * The whole inbox at a glance: why items are there, how urgent, and how long ago their issues were opened.
 * Parts come in a fixed order (never by size), so a slice keeps its place and color as the counts move:
 * reasons alphabetically by `why:` value, then items with no `why:` label, then stranded issues, then session
 * candidates;
 * priorities most urgent first, then unranked, then none. Empty parts are left out, except age buckets.
 * Age is from the issue's creation: GitHub's answer doesn't say when an item entered q:human.
 *
 * @param {InboxItem[]} items
 * @param {number} now
 * @returns {InboxStats}
 */
export function inboxStats(items, now) {
  /** @type {Map<string, Part>} */
  const parts = new Map()
  const bump = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string | null} */ tag) => {
    const p = parts.get(key) || { key, label, n: 0, tag }
    p.n += 1
    parts.set(key, p)
  }
  const DAY = 86_400_000
  const AGES = [
    ['age:0', 'under 1d', DAY],
    ['age:1', '1–7d', 7 * DAY],
    ['age:2', '1–4w', 28 * DAY],
    ['age:3', 'over 4w', Infinity],
  ]
  let oldest = /** @type {string | null} */ (null)
  for (const it of items) {
    if (it.kind === 'stranded') bump('why:~stranded', 'PR closed', 'kind:stranded')
    else if (it.kind === 'cost') bump('why:~cost', 'over budget', 'kind:cost')
    else if (it.why) bump(`why:${it.why}`, it.why, `why:${it.why}`)
    else bump('why:~none', 'no why:', null)
    if (it.priority) bump(`priority:${it.priority}`, it.priority, `priority:${it.priority}`)
    else bump('priority:~none', 'none', null)
    const born = it.createdAt ? Date.parse(it.createdAt) : NaN
    if (Number.isFinite(born)) {
      const age = now - born
      const [key, label] = /** @type {[string, string, number]} */ (
        AGES.find((a) => age < /** @type {number} */ (a[2]))
      )
      bump(key, label, null)
      if (!oldest || born < Date.parse(oldest)) oldest = it.createdAt
    }
    bump(`repo:${it.repo}`, it.repo, `repo:${it.repo}`)
  }
  const of = (/** @type {string} */ facet) => [...parts.values()].filter((p) => p.key.startsWith(`${facet}:`))
  const rank = (/** @type {Part} */ p) => (p.key === 'priority:~none' ? 6 : priorityRank(p.label))
  return {
    total: items.length,
    reasons: of('why').sort((a, b) => {
      const last = (/** @type {Part} */ p) => ['why:~none', 'why:~stranded', 'why:~cost'].indexOf(p.key)
      return last(a) - last(b) || a.label.localeCompare(b.label)
    }),
    priorities: of('priority').sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
    opened: AGES.map(
      ([key, label]) =>
        parts.get(/** @type {string} */ (key)) || { key: String(key), label: String(label), n: 0, tag: null },
    ),
    oldest,
    repos: of('repo').sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
  }
}
