// @ts-check
/**
 * `oakgreen proxy`: one local reverse proxy on :80 so each web UI of the stack has a name instead of a port:
 * `http://canopy.localhost/` → `127.0.0.1:4317`, `http://jaeger.localhost/` → `127.0.0.1:16686`.
 *
 * `*.localhost` always resolves to loopback (RFC 6761; browsers hardcode it), so no DNS or /etc/hosts setup, and
 * browsers treat it as a secure context.
 *
 * macOS lets an unprivileged process bind a port below 1024 only on the wildcard address, so it listens on `::`
 * (dual-stack). Connections from anything but loopback are destroyed on accept, and a request is answered only
 * when its Host is `localhost` or a `*.localhost` name, so another site cannot reach it through DNS rebinding.
 * Upstreams see `Host: 127.0.0.1:<port>` (canopy refuses foreign Host headers) plus `X-Forwarded-Host`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMigrated, forestPath, readForest, sectionOf, serviceDir } from '@oakgreencc/mycelium/forest'

export const LABEL = 'com.oakgreencc.proxy'
export const DEFAULT_PORT = 80
export const DEFAULT_ROUTES = Object.freeze({ canopy: 4317, jaeger: 16686 })

/** @typedef {Record<string, number>} Routes name → loopback port */

export const logPath = (/** @type {string} */ home) => join(serviceDir('proxy', { home }), 'logs', 'proxy.log')
export const plistPath = (/** @type {string} */ home) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Defaults, overlaid by forest.json's `proxy` section `{ "routes": { "<name>": <port> | null } }` (null drops one).
 * Throws on a machine still holding `~/.oakgreen/proxy.json` with no section (run `oakgreen config migrate`).
 * @param {{ home: string, env?: Record<string, string | undefined>, read?: (p: string) => string | null,
 *   exists?: (p: string) => boolean }} o
 * @returns {{ routes: Routes, errors: string[] }}
 */
export function loadRoutes({
  home,
  env = {},
  read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
  exists = existsSync,
}) {
  /** @type {Routes} */
  const routes = { ...DEFAULT_ROUTES }
  const errors = []
  const path = forestPath(undefined, { env, home })
  let cfg
  try {
    const { forest } = readForest(path, read)
    assertMigrated('proxy', forest, { env, home }, exists)
    cfg = sectionOf(forest, 'proxy')
  } catch (err) {
    const message = /** @type {Error} */ (err).message
    if (/oakgreen config migrate/.test(message)) throw err
    return { routes, errors: [message] }
  }
  for (const [name, port] of Object.entries(cfg?.routes ?? {})) {
    const n = name.toLowerCase()
    if (!NAME.test(n)) errors.push(`${path}: proxy route name '${name}' is not a DNS label`)
    else if (port === null) delete routes[n]
    else if (Number.isInteger(port) && port > 0 && port < 65536) routes[n] = port
    else errors.push(`${path}: proxy route '${name}' needs a port 1-65535, got ${JSON.stringify(port)}`)
  }
  return { routes, errors }
}

/** Hostname of a Host header, lowercased, without port, brackets or a trailing dot. */
export function hostnameOf(/** @type {string | undefined} */ header) {
  if (!header) return ''
  const h = header.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  return h.replace(/:\d+$/, '').replace(/\.$/, '')
}

/**
 * What a Host asks for: the index (`localhost`), a route name (`<name>.localhost`), or nothing we answer.
 * @param {string | undefined} header @returns {{ kind: 'index' } | { kind: 'route', name: string } | { kind: 'foreign' }}
 */
export function classify(header) {
  const h = hostnameOf(header)
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return { kind: 'index' }
  const m = /^([a-z0-9-]+)\.localhost$/.exec(h)
  return m ? { kind: 'route', name: m[1] } : { kind: 'foreign' }
}

/** @param {string | undefined} addr */
export const isLoopback = (addr) =>
  !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'))

/** @param {string} s */
const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** @param {Routes} routes @param {number} port */
export function indexPage(routes, port) {
  const suffix = port === 80 ? '' : `:${port}`
  const rows = Object.entries(routes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, p]) => {
      const url = `http://${n}.localhost${suffix}/`
      return `<li><a href="${html(url)}">${html(url)}</a> <span>→ 127.0.0.1:${p}</span></li>`
    })
    .join('\n')
  return `<!doctype html><meta charset="utf-8"><title>oakgreen proxy</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}span{opacity:.6}</style>
<h1>oakgreen proxy</h1><ul>
${rows}
</ul><p><span>Routes: defaults plus the proxy section of ~/.oakgreen/forest.json.</span></p>\n`
}

/**
 * @param {{ routes: Routes, port?: number, target?: string }} opts `target` is the upstream address (127.0.0.1).
 * @returns {import('node:http').Server}
 */
export function createProxy({ routes, port = DEFAULT_PORT, target = '127.0.0.1' }) {
  const server = createServer((req, res) => {
    const plain = (/** @type {number} */ status, /** @type {string} */ body, type = 'text/plain; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    const want = classify(req.headers.host)
    if (want.kind === 'foreign') return plain(403, 'forbidden host\n')
    if (want.kind === 'index') return plain(200, indexPage(routes, port), 'text/html; charset=utf-8')
    const upstream = routes[want.name]
    if (!upstream) return plain(404, `no route for ${want.name}.localhost; see http://localhost/\n`)
    const up = request(
      {
        host: target,
        port: upstream,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, target, upstream),
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      },
    )
    up.on('error', (err) => {
      if (res.headersSent) return res.destroy()
      plain(
        502,
        `${want.name}.localhost: nothing answering on ${target}:${upstream} (${/** @type {any} */ (err).code ?? err.message})\n`,
      )
    })
    req.pipe(up)
  })
  server.on('connection', (sock) => {
    if (!isLoopback(sock.remoteAddress)) sock.destroy()
  })
  // WebSockets and other upgrades: hand the raw socket through.
  server.on('upgrade', (req, sock, head) => {
    const want = classify(req.headers.host)
    const upstream = want.kind === 'route' ? routes[want.name] : undefined
    if (!upstream) return sock.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
    const up = connect(upstream, target, () => {
      const h = forwardHeaders(req.headers, target, upstream)
      const lines = Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`))
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(sock).pipe(up)
    })
    // Either side going away takes the other with it, errors included.
    up.on('close', () => sock.destroy())
    sock.on('close', () => up.destroy())
    up.on('error', () => sock.destroy())
    sock.on('error', () => up.destroy())
  })
  return server
}

/** @param {import('node:http').IncomingHttpHeaders} headers @param {string} target @param {number} port */
function forwardHeaders(headers, target, port) {
  return {
    ...headers,
    host: `${target}:${port}`,
    'x-forwarded-host': headers.host ?? '',
    'x-forwarded-proto': 'http',
  }
}

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The launchd agent that serves `oakgreen proxy` with `args`; KeepAlive restarts it. */
export function plist(
  /** @type {{ node: string, bin: string, args: string[], home: string, path: string, logFile: string }} */ o,
) {
  const argv = [o.node, o.bin, 'proxy', ...o.args].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${xml(o.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
    <key>HOME</key>
    <string>${xml(o.home)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(o.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.logFile)}</string>
</dict>
</plist>
`
}

export const OAKGREEN_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oakgreen.mjs')

/**
 * Write the agent. @param {string[]} args serve flags (`--port`)
 * @param {{ home: string, path: string, dryRun?: boolean, write?: (p: string, t: string) => void, out: (s: string) => void }} io
 * @returns {number}
 */
export function installProxy(args, { home, path, dryRun, write, out }) {
  const text = plist({ node: process.execPath, bin: OAKGREEN_BIN, args, home, path, logFile: logPath(home) })
  const target = plistPath(home)
  if (dryRun) {
    out(`# would write ${target}\n${text}`)
    return 0
  }
  const put =
    write ??
    ((/** @type {string} */ p, /** @type {string} */ t) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
      mkdirSync(dirname(logPath(home)), { recursive: true })
    })
  put(target, text)
  out(`wrote ${target}${args.length ? ` (serving with ${args.join(' ')})` : ''}\nstart it: oakgreen start proxy\n`)
  return 0
}
