// @ts-check
/**
 * The status file: what `mycelium run` is doing, for pages such as canopy to read without importing mycelium or
 * opening the settings file. It names each source, whether it is configured (and what it lacks if not), what it reads
 * (an app id, a package, a channel count: identifiers, never credentials), its interval, its last pass and when the
 * next is due. Rewritten atomically at start, after every pass and at a clean stop.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { serviceDir } from './forest.mjs'

export const STATUS_VERSION = 1

/** `$MYCELIUM_STATUS`, else `~/.oakgreen/mycelium/status.json`. @param {Record<string, string | undefined>} env @param {string} [home] */
export const defaultStatusPath = (env, home = undefined) =>
  env.MYCELIUM_STATUS || join(serviceDir('mycelium', { env, home }), 'status.json')

/**
 * What a configured source reads, from its settings: no token, key, password or account.
 *
 * @param {string} name @param {Record<string, string | undefined>} env @returns {string | null}
 */
export function targetOf(name, env) {
  const v = (/** @type {string} */ k) => String(env[k] ?? '').trim()
  if (name === 'discord') {
    const ids = v('MYCELIUM_DISCORD_CHANNELS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const forums = ids.filter((s) => s.startsWith('forum:')).length
    const plain = ids.length - forums
    const parts = [
      plain && `${plain} channel${plain === 1 ? '' : 's'}`,
      forums && `${forums} forum${forums === 1 ? '' : 's'}`,
    ]
    return parts.filter(Boolean).join(', ') || null
  }
  if (name === 'asc' || name === 'testflight')
    return v('MYCELIUM_ASC_APP_ID') ? `app ${v('MYCELIUM_ASC_APP_ID')}` : null
  if (name === 'play' || name === 'vitals') return v('MYCELIUM_PLAY_PACKAGE') || null
  if (name === 'device-logs') {
    let host = ''
    try {
      host = new URL(v('MYCELIUM_DEVICELOG_API')).host
    } catch {}
    const crashes = /^(1|true|yes|on)$/i.test(v('MYCELIUM_DEVICELOG_CRASHES'))
    return [v('MYCELIUM_DEVICELOG_STAGE') || 'prod', crashes ? 'bug reports and crashes' : 'bug reports', host]
      .filter(Boolean)
      .join(' · ')
  }
  return null
}

/**
 * @typedef {{ at: string, ms: number, ok: boolean, created?: number, commented?: number, skipped?: number,
 *   error?: string, message?: string }} LastPass
 * @typedef {{ name: string, configured: boolean, needs: string | null, target: string | null,
 *   intervalMs: number | null, last: LastPass | null, nextAt: string | null }} SourceStatus
 * @typedef {{ name: string, intervalMs: number, last: LastPass | null, nextAt: string | null }} JobStatus
 * @typedef {{ name: string, at: number, ms: number, nextAt: number, tally?: { created: number, commented: number,
 *   skipped: number }, message?: string, error?: string }} PassReport
 */

/**
 * The status of one `run`, written to `path` on every change.
 *
 * @param {{
 *   path: string,
 *   repo: string | null,
 *   sources: Omit<SourceStatus, 'last' | 'nextAt'>[],
 *   notify: { channels: string[], intervalMs: number } | null,
 *   now?: () => number,
 *   write?: (path: string, text: string) => void,
 *   pid?: number,
 *   host?: string,
 * }} o
 */
export function createStatus({
  path,
  repo,
  sources,
  notify,
  now = Date.now,
  write = atomicWrite,
  pid = process.pid,
  host = hostname(),
}) {
  const iso = (/** @type {number} */ t) => new Date(t).toISOString()
  const doc = {
    version: STATUS_VERSION,
    pid,
    host,
    repo,
    startedAt: iso(now()),
    updatedAt: iso(now()),
    stoppedAt: /** @type {string | null} */ (null),
    sources: sources.map(
      (s) => /** @type {SourceStatus} */ ({ ...s, last: null, nextAt: s.configured ? iso(now()) : null }),
    ),
    notify:
      notify &&
      /** @type {JobStatus & { channels: string[] }} */ ({ name: 'notify', ...notify, last: null, nextAt: iso(now()) }),
  }
  const flush = () => {
    doc.updatedAt = iso(now())
    try {
      write(path, `${JSON.stringify(doc, null, 2)}\n`)
    } catch {
      // A status file that cannot be written is a missing view, never the reason intake stops.
    }
  }
  flush()
  return {
    doc,
    /** One source or job finished a pass. @param {PassReport} r */
    pass(r) {
      const entry = r.name === 'notify' ? doc.notify : doc.sources.find((s) => s.name === r.name)
      if (!entry) return
      entry.last = {
        at: iso(r.at),
        ms: r.ms,
        ok: !r.error,
        ...(r.tally ?? {}),
        ...(r.message ? { message: r.message } : {}),
        ...(r.error ? { error: r.error } : {}),
      }
      entry.nextAt = iso(r.nextAt)
      flush()
    },
    stop() {
      doc.stoppedAt = iso(now())
      for (const s of doc.sources) s.nextAt = null
      if (doc.notify) doc.notify.nextAt = null
      flush()
    },
  }
}

/** @param {string} path @param {string} text */
function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
