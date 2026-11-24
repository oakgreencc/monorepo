// @ts-check
/**
 * A typed ask: what a person in the Human Queue is asked to do, so `q:human` is not one undifferentiated bucket.
 * Triage (phases/dispatch.mjs `TriageResult`) and rescue's `to-human` action (phases/rescue.mjs) may carry one.
 * cambium projects it as `ask:<kind>` labels next to `why:*` ({@link askLabels}), and renders it in the state
 * comment ({@link renderAsk}) so the person can answer with one comment. The labels leave with `q:human`
 * (labels.mjs `move`).
 *
 * - `decide`: a choice only a person can make; `options` lists the choices (two or more).
 * - `verify`: a check only a person can make (a physical device, an account a machine cannot reach).
 * - `chore`: offline work (a store listing, paperwork, a console setting); a checklist, not a session.
 * - `approve`: a yes or no on something already written.
 * `interactive`: whether a live session with the code would help answer it.
 * `lens`: for a `decide` worked through in a session, which kind of decision it is, so the session (`/oakgreen:decide`)
 * frames it right: `product` (what users get: scope, behaviour, wording, priority) or `technical` (how it is built:
 * architecture, interfaces, dependencies, data). Required on an interactive decide; an unknown value reads as absent.
 */
import { z } from 'zod'

export const ASK_KINDS = /** @type {const} */ (['decide', 'verify', 'chore', 'approve'])
/** Marks an ask whose answer a live session with the code would help (`interactive`). */
export const ASK_SESSION = 'ask:session'
export const ASK_LENSES = /** @type {const} */ (['product', 'technical'])

const text = z.string().trim().min(1)

export const Ask = z
  .object({
    kind: z.enum(ASK_KINDS),
    question: text,
    options: z
      .array(z.object({ label: text, detail: text }))
      .min(1)
      .optional(),
    recommendation: text.optional(),
    interactive: z.boolean(),
    // An unknown lens reads as none: dropped where it is optional; where it is required the refine below fails.
    lens: z.enum(ASK_LENSES).optional().catch(undefined),
  })
  .refine((a) => a.kind !== 'decide' || (a.options?.length ?? 0) >= 2, {
    message: 'a decide ask needs two or more options',
    path: ['options'],
  })
  .refine((a) => !(a.kind === 'decide' && a.interactive) || a.lens !== undefined, {
    message: `an interactive decide ask needs a lens (${ASK_LENSES.join(' or ')})`,
    path: ['lens'],
  })

/** @typedef {z.infer<typeof Ask>} AskT */

/**
 * An ask as a verdict field: a valid one is kept, an invalid one is dropped (undefined) without failing the verdict
 * around it, so an issue that needs a human still gets to one.
 */
export const LenientAsk = Ask.optional().catch(undefined)

/**
 * Why `raw` is not a valid ask, or null when it is (or is absent).
 * @param {unknown} raw @returns {string | null}
 */
export function askError(raw) {
  if (raw === undefined) return null
  const r = Ask.safeParse(raw)
  return r.success
    ? null
    : r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
}

/** The labels an ask adds beside `q:human`. @param {AskT | null | undefined} ask @returns {string[]} */
export const askLabels = (ask) => (ask ? [`ask:${ask.kind}`, ...(ask.interactive ? [ASK_SESSION] : [])] : [])

/** graft's refusal to add a label the repo does not have (graft/src/github/issues.mjs `labelIssue`). */
const MISSING_LABEL = /label '[^']+' does not exist/

/**
 * Hand an issue to a human with its ask's labels, or without them when the repo refuses them: a repo set up before
 * the `ask:*` labels existed lacks them, and the ask is in the state comment anyway. Without this the hand-off
 * fails, and is retried, every tick.
 * @param {{ log: (level: 'warn', msg: string, where?: { repo?: string, issue?: number }) => void }} ctx
 * @param {{ repo: string, issue: number }} where @param {AskT | null | undefined} ask
 * @param {(labels: string[]) => Promise<void>} handOff called with the ask's labels, then (on refusal) with none
 */
export async function withAskLabels(ctx, where, ask, handOff) {
  try {
    await handOff(askLabels(ask))
  } catch (err) {
    const msg = /** @type {Error} */ (err)?.message ?? String(err)
    if (!ask || !MISSING_LABEL.test(msg)) throw err
    ctx.log('warn', `${msg}; → q:human without ask labels (\`oakgreen setup\` adds them)`, where)
    await handOff([])
  }
}

const HEAD = /** @type {const} */ ({
  decide: 'Decide',
  verify: 'Verify',
  chore: 'Offline chore',
  approve: 'Approve',
})

/**
 * The ask as markdown for the state comment: the question, the options, the recommendation, and how to answer.
 * @param {AskT} ask @returns {string[]} lines
 */
export function renderAsk(ask) {
  const one = (/** @type {string} */ s) => s.replace(/\n+/g, ' ')
  return [
    `**${HEAD[ask.kind]}:** ${one(ask.question)}`,
    ...(ask.options?.length
      ? ['', ...ask.options.map((o, i) => `${i + 1}. **${one(o.label)}**: ${one(o.detail)}`)]
      : []),
    ...(ask.recommendation ? ['', `**Recommendation:** ${one(ask.recommendation)}`] : []),
    ...(ask.lens ? ['', `**Lens:** ${ask.lens}`] : []),
    '',
    `_${
      ask.kind === 'decide' && ask.options?.length
        ? 'Answer with one comment naming your choice'
        : ask.kind === 'approve'
          ? 'Answer with one comment: yes, or what to change'
          : 'Comment when it is done, with anything the work needs'
    }; cambium triages the issue again on your reply.${ask.interactive ? ' A live session with the code would help here.' : ''}_`,
  ]
}
