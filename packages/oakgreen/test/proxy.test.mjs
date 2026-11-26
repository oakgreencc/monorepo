// @ts-check
/** `oakgreen proxy`: routing by `*.localhost` Host, against real loopback sockets on ephemeral ports. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { classify, createProxy, hostnameOf, isLoopback, loadRoutes } from '../src/proxy.mjs'

/** @param {import('node:http').Server} s @returns {Promise<number>} */
async function listen(s, host = '127.0.0.1') {
  s.listen(0, host)
  await once(s, 'listening')
  return /** @type {import('node:net').AddressInfo} */ (s.address()).port
}

/** @param {number} port @param {string} host @param {string} [path] */
function get(port, host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host }, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** An upstream that echoes the Host headers it saw, and answers an Upgrade by echoing bytes. */
async function upstream() {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-up': 'yes' })
    res.end(JSON.stringify({ host: req.headers.host, fwd: req.headers['x-forwarded-host'], url: req.url }))
  })
  s.on('upgrade', (_req, sock) => {
    s.on('close', () => sock.destroy())
    sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: echo\r\nconnection: upgrade\r\n\r\n')
    sock.on('data', (d) => sock.write(d))
    sock.on('end', () => sock.end())
  })
  return { server: s, port: await listen(s) }
}

test('hostnameOf, classify and isLoopback', () => {
  assert.equal(hostnameOf('Canopy.LocalHost:80'), 'canopy.localhost')
  assert.equal(hostnameOf('canopy.localhost.'), 'canopy.localhost')
  assert.equal(hostnameOf('[::1]:80'), '::1')
  assert.deepEqual(classify('canopy.localhost'), { kind: 'route', name: 'canopy' })
  assert.deepEqual(classify('localhost:80'), { kind: 'index' })
  assert.deepEqual(classify('127.0.0.1'), { kind: 'index' })
  assert.deepEqual(classify('evil.example'), { kind: 'foreign' })
  assert.deepEqual(classify('canopy.localhost.evil.example'), { kind: 'foreign' })
  assert.deepEqual(classify('a.b.localhost'), { kind: 'foreign' })
  assert.deepEqual(classify(undefined), { kind: 'foreign' })
  assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'))
  assert.ok(!isLoopback('192.168.1.5') && !isLoopback('::ffff:10.0.0.2') && !isLoopback(undefined))
})

test("loadRoutes: defaults, overlaid by forest.json's proxy section; null drops one; bad entries are reported", () => {
  const none = () => false
  assert.deepEqual(loadRoutes({ home: '/h', read: () => null, exists: none }), {
    routes: { canopy: 4317, jaeger: 16686 },
    errors: [],
  })
  const r = loadRoutes({
    home: '/h',
    exists: none,
    read: (p) => {
      assert.equal(p, '/h/.oakgreen/forest.json')
      return JSON.stringify({
        proxy: { routes: { Grafana: 3000, jaeger: null, canopy: 4400, 'bad name': 1, x: 70000 } },
      })
    },
  })
  assert.deepEqual(r.routes, { canopy: 4400, grafana: 3000 })
  assert.equal(r.errors.length, 2)
  assert.match(loadRoutes({ home: '/h', read: () => '{', exists: none }).errors[0], /forest\.json/)
  const elsewhere = loadRoutes({
    home: '/h',
    env: { OAKGREEN_FOREST_CONFIG_PATH: '/f.json' },
    exists: none,
    read: (p) => (p === '/f.json' ? '{"proxy":{"routes":{"x":1}}}' : null),
  })
  assert.equal(elsewhere.routes.x, 1)
})

test('loadRoutes: only the old ~/.oakgreen/proxy.json there is refused, naming oakgreen config migrate', () => {
  const exists = (/** @type {string} */ p) => p === '/h/.oakgreen/proxy.json'
  assert.throws(() => loadRoutes({ home: '/h', read: () => null, exists }), /proxy\.json.*oakgreen config migrate/)
})

test('proxy: routes by name, rewrites Host for the upstream, refuses foreign Hosts, lists routes, 404s and 502s', async (t) => {
  const up = await upstream()
  const closed = createServer()
  const dead = await listen(closed) // a port nothing answers on
  closed.close()
  await once(closed, 'close')
  const proxy = createProxy({ routes: { canopy: up.port, gone: dead }, port: 80 })
  const port = await listen(proxy)
  t.after(() => {
    proxy.closeAllConnections()
    proxy.close()
    up.server.closeAllConnections()
    up.server.close()
  })

  const ok = /** @type {any} */ (await get(port, 'canopy.localhost', '/api/state?x=1'))
  assert.equal(ok.status, 200)
  assert.equal(ok.headers['x-up'], 'yes')
  assert.deepEqual(JSON.parse(ok.body), {
    host: `127.0.0.1:${up.port}`,
    fwd: 'canopy.localhost',
    url: '/api/state?x=1',
  })

  assert.equal(/** @type {any} */ (await get(port, 'evil.example')).status, 403)
  const index = /** @type {any} */ (await get(port, 'localhost'))
  assert.equal(index.status, 200)
  assert.match(index.body, /href="http:\/\/canopy\.localhost\/"/)
  const none = /** @type {any} */ (await get(port, 'nope.localhost'))
  assert.equal(none.status, 404)
  assert.match(none.body, /no route for nope\.localhost/)
  const bad = /** @type {any} */ (await get(port, 'gone.localhost'))
  assert.equal(bad.status, 502)
  assert.match(bad.body, /nothing answering/)
})

test('proxy: an Upgrade is passed through to the upstream both ways', async (t) => {
  const up = await upstream()
  const proxy = createProxy({ routes: { canopy: up.port } })
  const port = await listen(proxy)
  const sock = connect(port, '127.0.0.1')
  t.after(() => {
    sock.destroy()
    proxy.closeAllConnections()
    proxy.close()
    up.server.closeAllConnections()
    up.server.close()
  })
  sock.write('GET /ws HTTP/1.1\r\nhost: canopy.localhost\r\nupgrade: echo\r\nconnection: upgrade\r\n\r\n')
  let got = ''
  sock.on('data', (d) => {
    got += d
    if (got.includes('\r\n\r\n') && !got.includes('ping')) sock.write('ping')
  })
  for (let i = 0; i < 100 && !got.includes('ping'); i++) await new Promise((r) => setTimeout(r, 10))
  assert.match(got, /^HTTP\/1\.1 101/)
  assert.match(got, /ping$/)
})

test('oakgreen proxy install --dry-run prints the agent with its flags; bad flags exit 2', async () => {
  let out = ''
  let err = ''
  const io = {
    home: '/Users/me',
    env: { PATH: '/bin' },
    stdout: (/** @type {string} */ s) => (out += s),
    stderr: (/** @type {string} */ s) => (err += s),
  }
  assert.equal(await main(['proxy', 'install', '--dry-run', '--port', '8080'], io), 0)
  assert.match(out, /would write \/Users\/me\/Library\/LaunchAgents\/com\.oakgreencc\.proxy\.plist/)
  assert.match(out, /<string>proxy<\/string>\n {4}<string>--port<\/string>\n {4}<string>8080<\/string>/)
  assert.match(out, /\/Users\/me\/\.oakgreen\/proxy\/logs\/proxy\.log/)
  assert.equal(await main(['proxy', '--port', 'x'], io), 2)
  assert.match(err, /--port must be 0-65535/)
  assert.equal(await main(['proxy', '--bogus'], io), 2)
})

test('oakgreen proxy serves the configured routes and reports a port it cannot take', async () => {
  let out = ''
  let err = ''
  const io = {
    home: '/nonexistent-home',
    env: {},
    stdout: (/** @type {string} */ s) => (out += s),
    stderr: (/** @type {string} */ s) => (err += s),
  }
  /** @type {(s: import('node:http').Server) => Promise<number>} */
  const quick = async (s) => {
    s.listen(0, '127.0.0.1')
    await once(s, 'listening')
    s.close()
    return 0
  }
  assert.equal(await main(['proxy', '--port', '8080'], { ...io, listen: quick }), 0)
  assert.match(out, /http:\/\/canopy\.localhost:8080\/ → 127\.0\.0\.1:4317/)
  const busy = async () => {
    throw Object.assign(new Error('x'), { code: 'EADDRINUSE' })
  }
  assert.equal(await main(['proxy'], { ...io, listen: busy }), 1)
  assert.match(err, /port 80 is in use/)
})
