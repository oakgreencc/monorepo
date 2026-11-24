// @ts-check
/**
 * The snapshots file: each repo's full snapshot (what `github.read` returned this tick, after the tick's own writes),
 * written by the daemon next to the heartbeat (`paths.snapshots`) at the end of every tick. A `cambium run … --follow`
 * beside a live daemon reads it instead of querying GitHub itself ({@link daemonFeed}), so a follower costs no
 * GraphQL budget of its own.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SNAPSHOTS_VERSION = 1

/**
 * @typedef {import('./github.mjs').Snapshot} Snapshot
 * @typedef {{ slug: string, ok: boolean, error: string | null, fetchedAt: string | null, snapshot: any | null }} RepoSnapshot
 *   `fetchedAt`: when the tick that read it started (no later than the read itself). A repo not read this tick has
 *   `ok: false`, the error, and no snapshot: an old one is never passed off as fresh.
 * @typedef {{ version: number, writtenAt: string, tickSeconds: number, repos: RepoSnapshot[] }} SnapshotsFile
 * @typedef {{ live: false } | { live: true, snap: Snapshot | null, fetchedAt: number }} Feed
 *   `live: false`: no daemon, a stale heartbeat, or no usable file for this repo; read GitHub. `snap` null: the
 *   daemon could not read the repo this tick.
 */

/** A snapshot as plain JSON: `issues` becomes an array. @param {Snapshot} snap */
export const toJson = (snap) => ({ ...snap, issues: [...snap.issues.values()] })

/** The inverse of {@link toJson}. @param {any} o @returns {Snapshot} */
export const fromJson = (o) => ({
  ...o,
  issues: new Map(/** @type {import('./github.mjs').Issue[]} */ (o.issues).map((i) => [i.number, i])),
})

/**
 * @param {{ repos: string[], snaps: Map<string, Snapshot>, readErrors: Map<string, string>, fetchedAt: number,
 *   now: number, tickSeconds: number }} o
 * @returns {SnapshotsFile}
 */
export function snapshotsFile({ repos, snaps, readErrors, fetchedAt, now, tickSeconds }) {
  const at = new Date(fetchedAt).toISOString()
  return {
    version: SNAPSHOTS_VERSION,
    writtenAt: new Date(now).toISOString(),
    tickSeconds,
    repos: repos.map((slug) => {
      const snap = snaps.get(slug)
      if (snap) return { slug, ok: true, error: null, fetchedAt: at, snapshot: toJson(snap) }
      return { slug, ok: false, error: readErrors.get(slug) ?? 'not read this tick', fetchedAt: at, snapshot: null }
    }),
  }
}

/** Atomically: a temp file renamed over the old one. @param {string} path @param {SnapshotsFile} file */
export function writeSnapshots(path, file) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file)}\n`)
  renameSync(tmp, path)
}

/** The file, or null when it is missing, unreadable, or another version. @param {string} path @returns {SnapshotsFile | null} */
export function readSnapshots(path) {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8'))
    return file?.version === SNAPSHOTS_VERSION && Array.isArray(file.repos) ? file : null
  } catch {
    return null
  }
}

/**
 * A heartbeat is fresh while its last tick finished at most three ticks ago (`cambium status` calls it stale past that).
 * @param {any} hb @param {number} now
 */
export function heartbeatFresh(hb, now) {
  const age = (now - Date.parse(hb?.tick?.finishedAt)) / 1000
  return age <= (hb?.daemon?.tickSeconds ?? 0) * 3
}

/**
 * What a follower reads from a live daemon: the repo's latest snapshot from the file, when the heartbeat is fresh.
 * @param {{ readHeartbeat(): unknown, readSnapshots(): SnapshotsFile | null, now(): number }} o
 * @returns {{ latest(slug: string): Feed }}
 */
export function daemonFeed({ readHeartbeat, readSnapshots, now }) {
  return {
    latest(slug) {
      if (!heartbeatFresh(readHeartbeat(), now())) return { live: false }
      const repo = readSnapshots()?.repos.find((r) => r.slug === slug)
      const fetchedAt = Date.parse(repo?.fetchedAt ?? '')
      if (!repo || Number.isNaN(fetchedAt)) return { live: false }
      if (!repo.ok || !repo.snapshot) return { live: true, snap: null, fetchedAt }
      try {
        return { live: true, snap: fromJson(repo.snapshot), fetchedAt }
      } catch {
        return { live: false }
      }
    },
  }
}
