// @ts-check
/**
 * A disk cache of GitHub REST answers by ETag, so a repeated read costs no rate limit.
 *
 * A GET that comes back 200 with an `ETag` is kept: its body, its `Link` next page, and the tag. The next GET of
 * the same URL (and `Accept`) sends `If-None-Match`; a 304 is answered from the cache. GitHub does not count an
 * authorized 304 against the primary rate limit, and it validates the tag against what this token would see now,
 * so a cached body is never staler than a fresh one.
 *
 * Entries are one JSON file each under `dir`, named by a hash of the key. Anything that fails (a full disk, a
 * corrupt file, a race between two processes) is a cache miss, never an error. Bodies over {@link MAX_BODY} are not
 * kept. An entry's file mtime is its last use: a write sets it, and `touch` (called when a 304 is answered from
 * the entry) refreshes it. Entries unused for {@link MAX_AGE_MS} are pruned, a few at a time, when one is written.
 */
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** The largest body kept, in characters. */
export const MAX_BODY = 2 * 1024 * 1024

/** An entry nobody read or wrote for this long is pruned. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** At most this many stale entries are pruned per write, so no one write pays for a big sweep. */
const PRUNE_PER_WRITE = 20

/**
 * @typedef {{ etag: string, text: string, next: string | null }} CacheEntry
 * @typedef {{ get(key: string): CacheEntry | null, set(key: string, entry: CacheEntry): void, touch(key: string): void }} HttpCache
 *   `touch`: marks the entry used now, so a tag that keeps answering 304 is not pruned.
 */

/**
 * @param {string} dir
 * @param {{ now?: () => number }} [opts]
 * @returns {HttpCache}
 */
export function etagCache(dir, { now = Date.now } = {}) {
  const file = (/** @type {string} */ key) => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`)
  const prune = () => {
    try {
      let left = PRUNE_PER_WRITE
      for (const name of readdirSync(dir)) {
        if (left <= 0) break
        const p = join(dir, name)
        try {
          if (now() - statSync(p).mtimeMs > MAX_AGE_MS) {
            unlinkSync(p)
            left--
          }
        } catch {}
      }
    } catch {}
  }
  return {
    get(key) {
      try {
        const entry = JSON.parse(readFileSync(file(key), 'utf8'))
        if (typeof entry?.etag !== 'string' || typeof entry?.text !== 'string') return null
        return { etag: entry.etag, text: entry.text, next: entry.next ?? null }
      } catch {
        return null
      }
    },
    set(key, entry) {
      if (entry.text.length > MAX_BODY) return
      try {
        mkdirSync(dir, { recursive: true })
        const p = file(key)
        const tmp = `${p}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify(entry))
        renameSync(tmp, p)
        prune()
      } catch {}
    },
    touch(key) {
      try {
        const t = now() / 1000
        utimesSync(file(key), t, t)
      } catch {}
    },
  }
}
