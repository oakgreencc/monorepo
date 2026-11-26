// @ts-check
/**
 * Context — the one answer to "where am I" — against real git: a clone with
 * a bare origin, a linked worktree outside it, a broken `.graft.json`. Also the
 * callers that used to answer it themselves: the credential helper (App pin)
 * and the worktree-sync hook (base branch).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer } from '../src/cli/credential.mjs'
import { contextForPath, locate, projectFor, resolveContext } from '../src/context.mjs'
import { currentSession } from '../src/maintainer.mjs'
import { sync } from '../src/hooks/sync-worktree.mjs'

// Every git call in this process — the fixture's and Context's own — runs with
// the developer's global config masked (see integration.test.mjs for why).
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const ID = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...ID } })

/** origin (bare, default branch `main`), a clone of it, and a scratch root. */
function repo(t, { graft } = /** @type {{ graft?: string }} */ ({})) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graft-ctx-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const seed = join(root, 'seed')
  mkdirSync(seed)
  git(root, 'init', '-q', '-b', 'main', seed)
  writeFileSync(join(seed, 'a.txt'), 'one\n')
  if (graft !== undefined) writeFileSync(join(seed, '.graft.json'), graft)
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'base')
  const origin = join(root, 'origin.git')
  git(root, 'clone', '-q', '--bare', seed, origin)
  const clone = join(root, 'clone')
  git(root, 'clone', '-q', origin, clone)
  return { root, seed, origin, clone }
}

test('locate: the nearest .git entry, for a path that need not exist yet', (t) => {
  const { clone } = repo(t)
  assert.deepEqual(locate(join(clone, 'not/yet/here.txt')), { root: clone, rel: 'not/yet/here.txt' })
  assert.equal(locate('/'), null)
})

test("contextForPath: a linked worktree anywhere is its own checkout, sharing the clone's common dir", (t) => {
  const { root, clone } = repo(t)
  const wt = join(root, 'elsewhere', 'wt')
  git(clone, 'worktree', 'add', '-q', wt)
  const at = contextForPath()
  const inWt = at('src/x.mjs', wt)
  const inClone = at(join(clone, 'a.txt'), root)
  assert.ok(inWt && inClone)
  assert.equal(inWt.rel, 'src/x.mjs')
  assert.equal(inWt.ctx.root, wt)
  assert.equal(inClone.ctx.root, clone)
  assert.equal(inWt.ctx.gitCommonDir(), inClone.ctx.gitCommonDir())
  // Memoised per checkout: a second path in the same worktree is the same Context.
  assert.equal(at('other.txt', wt)?.ctx, inWt.ctx)
  assert.equal(at('/', '/'), null)
})

test('config is read on first use: a broken .graft.json refuses when asked for, not before', (t) => {
  const { clone } = repo(t, { graft: '{ not json' })
  const ctx = resolveContext({ cwd: clone })
  assert.equal(ctx.root, clone)
  assert.throws(() => ctx.config, /\.graft\.json/)
})

test('baseBranchOffline: .graft.json first, then origin/HEAD — and a broken config falls through', (t) => {
  const plain = repo(t)
  assert.equal(resolveContext({ cwd: plain.clone }).baseBranchOffline(), 'main')

  const pinned = repo(t, { graft: JSON.stringify({ baseBranch: 'develop' }) })
  assert.equal(resolveContext({ cwd: pinned.clone }).baseBranchOffline(), 'develop')

  const broken = repo(t, { graft: '{' })
  assert.equal(resolveContext({ cwd: broken.clone }).baseBranchOffline(), 'main')

  // A repository with no origin/HEAD and no config has no base.
  assert.equal(resolveContext({ cwd: plain.seed }).baseBranchOffline(), null)
})

test('baseBranch: .graft.json answers without a token', async (t) => {
  const { clone } = repo(t, { graft: JSON.stringify({ baseBranch: 'develop' }) })
  assert.equal(await resolveContext({ cwd: clone }).baseBranch(), 'develop')
})

test("currentSession: the event's session, then CLAUDE_CODE_SESSION_ID, then GRAFT_SESSION", () => {
  assert.equal(currentSession({ CLAUDE_CODE_SESSION_ID: 'env', GRAFT_SESSION: 'graft' }, { session_id: 'evt' }), 'evt')
  assert.equal(currentSession({ CLAUDE_CODE_SESSION_ID: 'env', GRAFT_SESSION: 'graft' }, {}), 'env')
  assert.equal(currentSession({ GRAFT_SESSION: 'graft' }, { session_id: '' }), 'graft')
  assert.equal(currentSession({}), null)
})

// ---------------------------------------------------------------------------
// The credential helper and the project's App pin
// ---------------------------------------------------------------------------

/** An GRAFT_HOME with two Apps: `by-owner` in the owner map, `pinned` only named by a project. */
function graftHome(root) {
  const home = join(root, 'graft-home')
  for (const [slug, id] of [
    ['by-owner', 1],
    ['pinned', 2],
  ]) {
    mkdirSync(join(home, 'apps', slug), { recursive: true })
    writeFileSync(join(home, 'apps', slug, 'app.json'), JSON.stringify({ id }))
    writeFileSync(join(home, 'apps', slug, 'private-key.pem'), 'not a real key')
  }
  writeFileSync(join(home, 'forest.json'), JSON.stringify({ graft: { owners: { acme: 'by-owner' } } }))
  return { GRAFT_HOME: home, OAKGREEN_FOREST_CONFIG_PATH: join(home, 'forest.json') }
}

test("credential helper: the project's app pin chooses the App for its own repository only", async (t) => {
  const { root, clone } = repo(t, { graft: JSON.stringify({ app: 'pinned' }) })
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  const env = { ...process.env, ...graftHome(root) }
  /** @type {string[]} */
  const minted = []
  const mint = async ({ appId }) => {
    minted.push(appId)
    return `tok-${appId}`
  }
  const fields = (path) => ({ protocol: 'https', host: 'github.com', path })

  // Inside the pinned repo, fetching it: the pin wins over the owner map.
  assert.equal(
    await answer(fields('acme/widgets.git'), { cwd: clone, env, mint }),
    'username=x-access-token\npassword=tok-2\n',
  )
  // The same checkout fetching ANOTHER repo of the owner: the pin does not apply.
  assert.equal(
    await answer(fields('acme/other.git'), { cwd: clone, env, mint }),
    'username=x-access-token\npassword=tok-1\n',
  )
  // Outside any checkout: the owner map.
  await answer(fields('acme/widgets.git'), { cwd: root, env, mint })
  assert.deepEqual(minted, ['2', '1', '1'])

  // Not github.com, or an owner nothing acts for: not mine.
  assert.equal(
    await answer({ protocol: 'https', host: 'gitlab.com', path: 'acme/widgets' }, { cwd: clone, env, mint }),
    null,
  )
  assert.equal(await answer(fields('stranger/x.git'), { cwd: root, env, mint }), null)
})

test('projectFor: null for a broken config or a different repository, never a throw', (t) => {
  const broken = repo(t, { graft: '{' })
  git(broken.clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git')
  assert.equal(projectFor({ owner: 'acme', repo: 'widgets', cwd: broken.clone }), null)

  const ok = repo(t, { graft: JSON.stringify({ app: 'pinned' }) })
  git(ok.clone, 'remote', 'set-url', 'origin', 'git@github.com:Acme/Widgets.git')
  assert.equal(projectFor({ owner: 'acme', repo: 'widgets', cwd: ok.clone })?.app, 'pinned')
  assert.equal(projectFor({ owner: 'acme', repo: 'gadgets', cwd: ok.clone }), null)
})

// ---------------------------------------------------------------------------
// sync-worktree: fast-forward a NEW worktree onto the base, never destroy
// ---------------------------------------------------------------------------

/** origin/main moves one commit ahead of the clone. */
function advanceOrigin({ root, origin }) {
  const tmp = join(root, 'pusher')
  git(root, 'clone', '-q', origin, tmp)
  writeFileSync(join(tmp, 'b.txt'), 'two\n')
  git(tmp, 'add', '.')
  git(tmp, 'commit', '-qm', 'ahead')
  // A bare fixture remote: updating its ref is the "someone else merged" step.
  git(origin, 'fetch', '-q', tmp, 'main:main')
  return git(origin, 'rev-parse', 'main').trim()
}
const created = (wt) => ({ tool_input: {}, tool_response: `Created worktree at ${wt} on branch x`, cwd: '/' })

test('sync: a clean new worktree behind the base is fast-forwarded', (t) => {
  const r = repo(t)
  const target = advanceOrigin(r)
  const msg = sync(created(r.clone))
  assert.match(String(msg), /fast-forwarded .* → .* \(origin\/main\)/)
  assert.equal(git(r.clone, 'rev-parse', 'HEAD').trim(), target)
})

test('sync: a dirty worktree, a diverged one, and an EXISTING one are left alone', (t) => {
  const dirty = repo(t)
  advanceOrigin(dirty)
  writeFileSync(join(dirty.clone, 'a.txt'), 'edited\n')
  const before = git(dirty.clone, 'rev-parse', 'HEAD').trim()
  assert.match(String(sync(created(dirty.clone))), /uncommitted changes, so it was NOT synced/)
  assert.equal(git(dirty.clone, 'rev-parse', 'HEAD').trim(), before)

  const diverged = repo(t)
  advanceOrigin(diverged)
  writeFileSync(join(diverged.clone, 'mine.txt'), 'mine\n')
  git(diverged.clone, 'add', '.')
  git(diverged.clone, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'mine')
  const mine = git(diverged.clone, 'rev-parse', 'HEAD').trim()
  assert.match(String(sync(created(diverged.clone))), /diverged\. Left untouched/)
  assert.equal(git(diverged.clone, 'rev-parse', 'HEAD').trim(), mine)

  const existing = repo(t)
  advanceOrigin(existing)
  assert.equal(sync({ ...created(existing.clone), tool_input: { path: existing.clone } }), null)
})

test('sync: the main checkout is fast-forwarded too: in place when on the base, by ref when elsewhere, never when dirty', (t) => {
  const linked = (/** @type {ReturnType<typeof repo>} */ r) => {
    const wt = join(r.root, 'wt')
    git(r.clone, 'worktree', 'add', '-q', '--detach', wt, 'origin/main')
    return wt
  }

  const onBase = repo(t)
  const target = advanceOrigin(onBase)
  assert.match(String(sync(created(linked(onBase)))), /Main checkout main fast-forwarded .* → /)
  assert.equal(git(onBase.clone, 'rev-parse', 'HEAD').trim(), target)

  const elsewhere = repo(t)
  git(elsewhere.clone, 'switch', '-q', '-c', 'feature')
  const target2 = advanceOrigin(elsewhere)
  sync(created(linked(elsewhere)))
  assert.equal(git(elsewhere.clone, 'rev-parse', 'refs/heads/main').trim(), target2)
  assert.equal(git(elsewhere.clone, 'symbolic-ref', '--short', 'HEAD').trim(), 'feature')

  const dirty = repo(t)
  advanceOrigin(dirty)
  const before = git(dirty.clone, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(dirty.clone, 'a.txt'), 'edited\n')
  assert.match(String(sync(created(linked(dirty)))), /Main checkout .* uncommitted changes/)
  assert.equal(git(dirty.clone, 'rev-parse', 'HEAD').trim(), before)
})

test('sync: an up-to-date worktree says nothing', (t) => {
  const r = repo(t)
  assert.equal(sync(created(r.clone)), null)
})
