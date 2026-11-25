// @ts-check
/** `oakgreen update` with a fake registry, npm and launchd; nothing leaves the process. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  REGISTRY_WAITS,
  globalTools,
  installOf,
  latestManifest,
  missingOnRegistry,
  neededSpecs,
  newer,
  staleTools,
  toolVersions,
} from '../src/update.mjs'
import { run, tempDir } from './helpers.mjs'

/**
 * @param {{ latest?: string, current?: string, global?: boolean, fail?: string | string[],
 *   pins?: Record<string, string>, tools?: Record<string, string>, absent?: string[][], doctorCode?: number }} [o]
 *   `fail`: one message for every install, or one per attempt (then success); `absent`: what the registry lacks on
 *   each successive look (then nothing)
 */
function fakeUpdater({
  latest = '0.1.0',
  current = '0.0.31',
  global = true,
  fail,
  pins = {},
  tools = {},
  absent = [],
  doctorCode = 0,
} = {}) {
  const installs = /** @type {{ prefix: string, specs: string[] }[]} */ ([])
  const looks = /** @type {string[][]} */ ([])
  const fails = Array.isArray(fail) ? [...fail] : null
  let doctors = 0
  const version = () => (installs.length ? 'new' : 'old')
  /** @type {import('../src/update.mjs').Updater} */
  const updater = {
    current,
    installOf: () => (global ? { prefix: '/opt/homebrew', dir: '/opt/homebrew/lib/node_modules/oakgreen' } : null),
    latest: async () => ({ version: latest, dependencies: pins }),
    globals: () => tools,
    install: async (prefix, specs) => {
      const f = fails ? fails.shift() : fail
      if (f) throw new Error(f)
      installs.push({ prefix, specs })
    },
    versions: () => ({ oakgreen: `${version()}-o`, graft: `${version()}-g`, cambium: `${version()}-c`, canker: null }),
    missing: async (specs) => {
      looks.push(specs)
      return (absent[looks.length - 1] ?? []).filter((s) => specs.includes(s))
    },
    doctor: async () => {
      doctors++
      return doctorCode
    },
  }
  return { updater, installs, looks, doctors: () => doctors }
}

/** launchctl where `running` agents have a pid and a TERM gives them a new one. @param {string[]} running */
function fakeLaunchctl(running) {
  const pids = /** @type {Record<string, number>} */ ({})
  let next = 100
  for (const n of running) pids[`com.oakgreencc.${n}`] = ++next
  const calls = /** @type {string[][]} */ ([])
  /** @type {import('../src/tools.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    const label = /** @type {string} */ (args.at(-1)).split('/').at(-1) ?? ''
    if (args[0] === 'print')
      return label in pids
        ? { code: 0, stdout: `\tstate = running\n\tpid = ${pids[label]}\n`, stderr: '' }
        : { code: 113, stdout: '', stderr: 'Could not find service' }
    if (args[0] === 'kill') {
      pids[label] = ++next
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
  return { exec, calls }
}

const ports = (/** @type {any} */ o) => ({
  platform: 'darwin',
  uid: 501,
  home: '/Users/me',
  exists: () => true,
  sleep: async () => {},
  ...o,
})

test('up to date: says so, installs nothing', async () => {
  const { updater, installs } = fakeUpdater({ latest: '0.0.31' })
  const r = await run(['update'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0)
  assert.match(r.out, /oakgreen 0\.0\.31 is up to date/)
  assert.match(
    r.out,
    /versions:\n {2}oakgreen old-o\n {2}graft {4}old-g\n {2}cambium {2}old-c\n {2}canker {3}not installed\n/,
  )
  assert.deepEqual(installs, [])
})

test('--check reports a newer version without installing', async () => {
  const { updater, installs } = fakeUpdater()
  const r = await run(['update', '--check'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0)
  assert.match(r.out, /0\.0\.31 → 0\.1\.0 available/)
  assert.match(r.out, /cambium {2}old-c/)
  assert.deepEqual(installs, [])
})

test('installs into the same prefix, then restarts only the running services', async () => {
  const { updater, installs } = fakeUpdater()
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['oakgreen@0.1.0'] }])
  assert.match(r.out, /✓ oakgreen 0\.0\.31 → 0\.1\.0/)
  assert.match(r.out, /✓ cambium {2}restarted, pid 101 → 102/)
  assert.match(r.out, /versions:\n {2}oakgreen new-o\n {2}graft {4}new-g\n/)
  assert.doesNotMatch(r.out, /(mycelium|otelcol) +restart/)
  assert.deepEqual(
    lc.calls.filter((c) => c[1] === 'kill'),
    [['launchctl', 'kill', 'TERM', 'gui/501/com.oakgreencc.cambium']],
  )
})

test('standalone tools older than the pins are upgraded in the same install; newer or unpinned ones are left', async () => {
  const { updater, installs } = fakeUpdater({
    pins: { '@oakgreencc/cambium': '0.0.45', '@oakgreencc/graft': '0.2.21', '@oakgreencc/canopy': '0.0.29' },
    tools: { '@oakgreencc/cambium': '0.0.38', '@oakgreencc/graft': '0.2.30', '@oakgreencc/other': '0.0.1' },
  })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['oakgreen@0.1.0', '@oakgreencc/cambium@0.0.45'] }])
  assert.match(r.out, /✓ @oakgreencc\/cambium 0\.0\.38 → 0\.0\.45/)
  assert.doesNotMatch(r.out, /(graft|canopy|other) \S+ →/)
  assert.match(r.out, /✓ cambium {2}restarted/)
})

test('oakgreen current but a standalone tool behind: upgrades the tool and restarts', async () => {
  const { updater, installs } = fakeUpdater({
    latest: '0.0.31',
    pins: { '@oakgreencc/cambium': '0.0.45' },
    tools: { '@oakgreencc/cambium': '0.0.38' },
  })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['@oakgreencc/cambium@0.0.45'] }])
  assert.doesNotMatch(r.out, /up to date|✓ oakgreen/)
  assert.equal(lc.calls.filter((c) => c[1] === 'kill').length, 1)
})

test('--check lists stale standalone tools too', async () => {
  const { updater, installs } = fakeUpdater({
    latest: '0.0.31',
    pins: { '@oakgreencc/cambium': '0.0.45' },
    tools: { '@oakgreencc/cambium': '0.0.38' },
  })
  const r = await run(['update', '--check'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0)
  assert.match(r.out, /@oakgreencc\/cambium 0\.0\.38 → 0\.0\.45 available/)
  assert.deepEqual(installs, [])
})

test('not a global install: refuses, installs nothing', async () => {
  const { updater, installs } = fakeUpdater({ global: false })
  const r = await run(['update'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 1)
  assert.match(r.err, /not a global npm install/)
  assert.deepEqual(installs, [])
})

test('a failed npm install exits 1 and restarts nothing', async () => {
  const { updater } = fakeUpdater({ fail: 'npm install oakgreen@0.1.0 failed: EACCES' })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 1)
  assert.match(r.err, /EACCES/)
  assert.equal(lc.calls.filter((c) => c[1] === 'kill').length, 0)
})

test('off macOS: installs, skips services', async () => {
  const { updater, installs } = fakeUpdater()
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec, platform: 'linux' }))
  assert.equal(r.code, 0)
  assert.equal(installs.length, 1)
  assert.deepEqual(lc.calls, [])
})

test('every update ends with the installed oakgreen doctor; --check and a failed install do not', async () => {
  const upToDate = fakeUpdater({ latest: '0.0.31' })
  let r = await run(['update'], ports({ updater: upToDate.updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(upToDate.doctors(), 1)
  assert.match(r.out, /oakgreen doctor\n/)

  const updated = fakeUpdater()
  r = await run(['update'], ports({ updater: updated.updater, exec: fakeLaunchctl(['cambium']).exec }))
  assert.equal(updated.doctors(), 1)
  assert.ok(r.out.indexOf('restarted') < r.out.indexOf('oakgreen doctor'), 'doctor runs after the restarts')

  const checked = fakeUpdater()
  await run(['update', '--check'], ports({ updater: checked.updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(checked.doctors(), 0)

  const failed = fakeUpdater({ fail: 'EACCES' })
  await run(['update'], ports({ updater: failed.updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(failed.doctors(), 0)
})

test('doctor finding problems is reported but the update still exits 0', async () => {
  const { updater } = fakeUpdater({ doctorCode: 1 })
  const r = await run(['update'], ports({ updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /oakgreen setup/)
})

test('a pinned tool the registry does not serve yet: waits, then installs once it is there', async () => {
  const slept = /** @type {number[]} */ ([])
  const { updater, installs, looks } = fakeUpdater({
    pins: { '@oakgreencc/cambium': '0.0.45', '@oakgreencc/graft': 'workspace:*' },
    absent: [['@oakgreencc/cambium@0.0.45'], ['@oakgreencc/cambium@0.0.45']],
  })
  const r = await run(
    ['update'],
    ports({ updater, exec: fakeLaunchctl([]).exec, sleep: async (/** @type {number} */ ms) => slept.push(ms) }),
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(looks[0], ['oakgreen@0.1.0', '@oakgreencc/cambium@0.0.45'])
  assert.equal(looks.length, 3)
  assert.deepEqual(slept, [REGISTRY_WAITS[0] * 1000, REGISTRY_WAITS[1] * 1000])
  assert.match(r.out, /registry does not serve @oakgreencc\/cambium@0\.0\.45 yet; looking again in 10s/)
  assert.deepEqual(installs, [{ prefix: '/opt/homebrew', specs: ['oakgreen@0.1.0'] }])
})

test('still missing after every wait: exits 1, installs and restarts nothing', async () => {
  const { updater, installs, doctors } = fakeUpdater({
    pins: { '@oakgreencc/cambium': '0.0.45' },
    absent: Array(REGISTRY_WAITS.length + 1).fill(['@oakgreencc/cambium@0.0.45']),
  })
  const lc = fakeLaunchctl(['cambium'])
  const r = await run(['update'], ports({ updater, exec: lc.exec }))
  assert.equal(r.code, 1)
  assert.match(r.err, /does not serve @oakgreencc\/cambium@0\.0\.45 yet.*nothing was installed/)
  assert.deepEqual(installs, [])
  assert.equal(lc.calls.filter((c) => c[1] === 'kill').length, 0)
  assert.equal(doctors(), 0)
})

test('npm ETARGET is retried; other npm failures are not', async () => {
  const lag = fakeUpdater({ fail: ['npm install failed: npm error code ETARGET No matching version found'] })
  let r = await run(['update'], ports({ updater: lag.updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /npm cannot find a version yet/)
  assert.equal(lag.installs.length, 1)

  const perm = fakeUpdater({ fail: ['npm install failed: EACCES', ''] })
  r = await run(['update'], ports({ updater: perm.updater, exec: fakeLaunchctl([]).exec }))
  assert.equal(r.code, 1)
  assert.equal(perm.installs.length, 0)
})

test("neededSpecs adds oakgreen's exact pins only when oakgreen is installed", () => {
  const latest = { version: '0.1.0', dependencies: { '@oakgreencc/a': '1.0.0', '@oakgreencc/b': '^1.0.0' } }
  assert.deepEqual(neededSpecs(['oakgreen@0.1.0', '@oakgreencc/c@2.0.0'], latest), [
    'oakgreen@0.1.0',
    '@oakgreencc/c@2.0.0',
    '@oakgreencc/a@1.0.0',
  ])
  assert.deepEqual(neededSpecs(['@oakgreencc/c@2.0.0'], latest), ['@oakgreencc/c@2.0.0'])
})

test('missingOnRegistry: only a 404 is missing', async () => {
  /** @type {string[]} */
  const urls = []
  const fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      urls.push(url)
      if (url.includes('boom')) throw new Error('offline')
      return { status: url.endsWith('/0.0.45') ? 404 : url.includes('flaky') ? 503 : 200 }
    }
  )
  assert.deepEqual(
    await missingOnRegistry(['@oakgreencc/cambium@0.0.45', 'oakgreen@0.1.0', 'flaky@1.0.0', 'boom@1.0.0'], { fetch }),
    ['@oakgreencc/cambium@0.0.45'],
  )
  assert.equal(urls[0], 'https://registry.npmjs.org/@oakgreencc%2fcambium/0.0.45')
})

test('unknown argument is a usage error', async () => {
  const r = await run(['update', '--force'], ports({ updater: fakeUpdater().updater }))
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown argument --force/)
})

test('installOf: only <prefix>/lib/node_modules/oakgreen', () => {
  assert.deepEqual(installOf('/opt/homebrew/lib/node_modules/oakgreen'), {
    prefix: '/opt/homebrew',
    dir: '/opt/homebrew/lib/node_modules/oakgreen',
  })
  assert.equal(installOf('/src/monorepo/packages/oakgreen'), null)
  assert.equal(installOf('/x/lib/node_modules/other/node_modules/oakgreen'), null)
})

test('newer compares x.y.z numerically', () => {
  assert.equal(newer('0.0.10', '0.0.9'), true)
  assert.equal(newer('0.0.9', '0.0.10'), false)
  assert.equal(newer('1.0.0', '1.0.0'), false)
  assert.equal(newer('1.0.0-rc.1', '0.9.9'), true)
})

test('staleTools: only older, exactly pinned tools', () => {
  assert.deepEqual(
    staleTools(
      { '@oakgreencc/a': '1.0.0', '@oakgreencc/b': '1.0.0', '@oakgreencc/c': 'workspace:*', '@oakgreencc/d': '^2.0.0' },
      { '@oakgreencc/a': '0.9.0', '@oakgreencc/b': '1.0.0', '@oakgreencc/c': '0.1.0', '@oakgreencc/d': '1.0.0' },
    ),
    [{ name: '@oakgreencc/a', from: '0.9.0', to: '1.0.0' }],
  )
})

test('globalTools reads each scoped package version under the prefix', () => {
  const prefix = tempDir({
    'lib/node_modules/@oakgreencc/cambium/package.json': JSON.stringify({ version: '0.0.38' }),
    'lib/node_modules/@oakgreencc/broken/package.json': '{',
    'lib/node_modules/oakgreen/package.json': JSON.stringify({ version: '0.0.63' }),
  })
  assert.deepEqual(globalTools(prefix), { '@oakgreencc/cambium': '0.0.38' })
  assert.deepEqual(globalTools(`${prefix}/missing`), {})
})

test('latestManifest reads the latest dist-tag', async () => {
  /** @type {string[]} */
  const urls = []
  const fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ version: '0.2.0', dependencies: { '@oakgreencc/cambium': '0.0.45' } }) }
    }
  )
  assert.deepEqual(await latestManifest({ fetch }), {
    version: '0.2.0',
    dependencies: { '@oakgreencc/cambium': '0.0.45' },
  })
  assert.deepEqual(urls, ['https://registry.npmjs.org/oakgreen/latest'])
  const bad = /** @type {any} */ (async () => ({ ok: false, status: 503 }))
  await assert.rejects(latestManifest({ fetch: bad }), /503/)
})

test('toolVersions: oakgreen, then every tool; a standalone copy wins over the bundled one', () => {
  const bundled = (/** @type {string} */ name, /** @type {string} */ version) => [
    `lib/node_modules/oakgreen/node_modules/@oakgreencc/${name}/package.json`,
    JSON.stringify({ name: `@oakgreencc/${name}`, version }),
  ]
  const prefix = tempDir({
    'lib/node_modules/oakgreen/package.json': JSON.stringify({ name: 'oakgreen', version: '0.0.70' }),
    ...Object.fromEntries([
      bundled('graft', '0.2.20'),
      bundled('canker', '0.0.7'),
      bundled('deadwood', '0.0.8'),
      bundled('cambium', '0.0.45'),
      bundled('mycelium', '0.0.20'),
      bundled('canopy', '0.0.30'),
    ]),
    'lib/node_modules/@oakgreencc/graft/package.json': JSON.stringify({ name: '@oakgreencc/graft', version: '0.2.22' }),
  })
  assert.deepEqual(toolVersions({ dir: `${prefix}/lib/node_modules/oakgreen`, prefix }), {
    oakgreen: '0.0.70',
    graft: '0.2.22',
    canker: '0.0.7',
    deadwood: '0.0.8',
    cambium: '0.0.45',
    mycelium: '0.0.20',
    canopy: '0.0.30',
  })
})
