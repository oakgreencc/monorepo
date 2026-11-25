// @ts-check
/**
 * `graft worktree done` (#73): after publish → merge, the worktree's branch is
 * rewound to the commit EnterWorktree recorded, so ExitWorktree `remove` sees
 * no commits to lose — and a worktree holding work GitHub lacks is not.
 *
 * Real git, the bare-repo fake standing in for GitHub. `exitWorktreeCounts`
 * is ExitWorktree's own question: `git rev-list --count refs/heads/<branch>
 * ^<recorded sha>`, and uncommitted paths.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as cli, finishAfterMerge } from '../src/cli/worktree.mjs'
import { finish } from '../src/hooks/finish-worktree.mjs'
import { sync } from '../src/hooks/sync-worktree.mjs'
import { advance, publishWorktree, resolveBranch } from '../src/publish/publish.mjs'
import { localOnly } from '../src/status.mjs'
import { ENTERED_AT, enteredAt, rewind, strayPaths, tidy } from '../src/worktree.mjs'
import { gitIn, must, run, scenario } from './fixtures.mjs'

const BRANCH = 'worktree-x'

/** Someone else lands a commit on origin's develop. */
function landElsewhere(s, file) {
  const tmp = join(s.root, `other-${file}`)
  run(s.root, ['clone', '-q', s.bare, tmp])
  writeFileSync(join(tmp, file), 'theirs\n')
  run(tmp, ['add', '.'])
  run(tmp, ['-c', 'commit.gpgsign=false', 'commit', '-qm', `theirs ${file}`])
  run(s.bare, ['fetch', '-q', tmp, 'develop:develop'])
}

/** GitHub merges agent/x into develop with a merge commit, as the queue does. */
function mergeOnGitHub(s) {
  const tmp = join(s.root, 'merger')
  run(s.root, ['clone', '-q', s.bare, tmp])
  run(tmp, ['fetch', '-q', 'origin', 'agent/x'])
  run(tmp, ['-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', 'Merge agent/x', 'FETCH_HEAD'])
  run(s.bare, ['fetch', '-q', tmp, 'develop:develop'])
  return run(tmp, ['rev-parse', 'HEAD']).trim()
}

/**
 * The issue's repro up to ExitWorktree: EnterWorktree from a main checkout
 * behind origin (the sync hook fast-forwards it), publish, merge on GitHub.
 */
async function enteredPublishedMerged() {
  const s = scenario()
  const recorded = run(s.wt, ['rev-parse', 'HEAD']).trim()
  landElsewhere(s, 'e.txt')
  const lwt = join(s.root, 'lwt')
  run(s.wt, ['worktree', 'add', '-q', '-b', BRANCH, lwt, 'HEAD'])
  run(s.wt, ['remote', 'set-head', 'origin', 'develop'])
  const msg = sync({
    tool_input: {},
    tool_response: `Created worktree at ${lwt} on branch ${BRANCH}`,
    cwd: '/',
  })
  assert.match(String(msg), /Worktree fast-forwarded/)

  const git = gitIn(lwt)
  writeFileSync(join(lwt, 'a.txt'), 'changed\n')
  const base = must(
    await resolveBranch({
      client: s.client,
      owner: 'o',
      repo: 'r',
      branch: 'develop',
    }),
  )
  const out = await publishWorktree({
    git,
    client: s.client,
    owner: 'o',
    repo: 'r',
    branch: 'agent/x',
    head: null,
    base,
    message: 'feat: x',
    paths: ['a.txt'],
  })
  run(lwt, ['fetch', '-q', 'origin', 'agent/x'])
  must(advance({ git, target: out.commit.sha }).advanced)
  const merge = mergeOnGitHub(s)
  return { ...s, lwt, lgit: git, recorded, merge }
}

/** What ExitWorktree remove would refuse over. */
const exitWorktreeCounts = (/** @type {{ lwt: string, recorded: string }} */ s) => ({
  commits: Number(run(s.lwt, ['rev-list', '--count', `refs/heads/${BRANCH}`, `^${s.recorded}`, '--']).trim()),
  changed: run(s.lwt, ['status', '--porcelain', '-uall']).trim(),
})

const ask = (s) =>
  localOnly({
    git: s.lgit,
    client: s.client,
    owner: 'o',
    repo: 'r',
    base: 'develop',
    branch: 'agent/x',
  })

test('sync-worktree records the commit the worktree was created on, before moving it', async () => {
  const s = await enteredPublishedMerged()
  try {
    const file = run(s.lwt, ['rev-parse', '--path-format=absolute', '--git-path', ENTERED_AT]).trim()
    assert.equal(readFileSync(file, 'utf8').trim(), s.recorded)
    assert.equal(enteredAt(s.lgit, BRANCH), s.recorded)
  } finally {
    s.cleanup()
  }
})

test('published and merged: the branch is rewound and ExitWorktree has nothing to count', async () => {
  const s = await enteredPublishedMerged()
  try {
    // The bug: the sync fast-forward plus the GitHub-made commit, all published.
    assert.ok(exitWorktreeCounts(s).commits >= 2, 'the repro shows commits before the fix')
    const status = await ask(s)
    assert.deepEqual([status.dirty, status.unpublished], [[], []])
    const out = rewind({ git: s.lgit, status })
    assert.equal(out.rewound, true)
    assert.deepEqual(exitWorktreeCounts(s), { commits: 0, changed: '' })
    // A second call is a no-op.
    assert.deepEqual(rewind({ git: s.lgit, status: await ask(s) }), {
      rewound: false,
      why: 'already-there',
      to: s.recorded,
    })
  } finally {
    s.cleanup()
  }
})

test('a local commit GitHub lacks is never rewound: ExitWorktree still refuses', async () => {
  const s = await enteredPublishedMerged()
  try {
    writeFileSync(join(s.lwt, 'b.txt'), 'wip\n')
    run(s.lwt, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'wip'])
    const head = run(s.lwt, ['rev-parse', 'HEAD']).trim()
    const status = await ask(s)
    assert.deepEqual(status.unpublished, [head])
    assert.deepEqual(rewind({ git: s.lgit, status }), {
      rewound: false,
      why: 'local-only',
    })
    assert.equal(run(s.lwt, ['rev-parse', 'HEAD']).trim(), head)
    assert.ok(exitWorktreeCounts(s).commits > 0)
  } finally {
    s.cleanup()
  }
})

test('uncommitted paths are never rewound over', async () => {
  const s = await enteredPublishedMerged()
  try {
    writeFileSync(join(s.lwt, 'new.txt'), 'unsaved\n')
    const before = run(s.lwt, ['rev-parse', 'HEAD']).trim()
    assert.deepEqual(rewind({ git: s.lgit, status: await ask(s) }), {
      rewound: false,
      why: 'local-only',
    })
    assert.equal(run(s.lwt, ['rev-parse', 'HEAD']).trim(), before)
    assert.equal(readFileSync(join(s.lwt, 'new.txt'), 'utf8'), 'unsaved\n')
  } finally {
    s.cleanup()
  }
})

test('without the hook record, the branch reflog gives the creation commit', () => {
  const s = scenario()
  try {
    const created = run(s.wt, ['rev-parse', 'HEAD']).trim()
    const lwt = join(s.root, 'lwt')
    run(s.wt, ['worktree', 'add', '-q', '-b', BRANCH, lwt, 'HEAD'])
    writeFileSync(join(lwt, 'a.txt'), 'later\n')
    run(lwt, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'later'])
    assert.equal(enteredAt(gitIn(lwt), BRANCH), created)
  } finally {
    s.cleanup()
  }
})

test('graft worktree done: refuses the main checkout; rewinds and fast-forwards local develop; exits 1 on local work', async () => {
  const s = await enteredPublishedMerged()
  try {
    const lines = []
    const say = (/** @type {string} */ l) => lines.push(l)
    await assert.rejects(cli(['done', '-C', s.wt, '--repo', 'o/r'], { client: s.client, say }), /main checkout/)

    // .graft.json names the base; excluded so it is not local work.
    writeFileSync(join(s.lwt, '.graft.json'), JSON.stringify({ baseBranch: 'develop' }))
    writeFileSync(join(s.wt, '.git', 'info', 'exclude'), '.graft.json\n')

    assert.equal(
      await cli(['done', 'agent/x', '-C', s.lwt, '--repo', 'o/r'], {
        client: s.client,
        say,
      }),
      0,
    )
    assert.ok(lines.includes('nothing local that GitHub does not have'), lines.join('\n'))
    assert.ok(
      lines.some((l) => /^Rewound worktree-x .* the commit this worktree was created on/.test(l)),
      lines.join('\n'),
    )
    assert.deepEqual(exitWorktreeCounts(s), { commits: 0, changed: '' })
    // The main checkout's develop now holds the merge, so the branch's work is in local develop too.
    assert.equal(run(s.wt, ['rev-parse', 'refs/heads/develop']).trim(), s.merge)

    writeFileSync(join(s.lwt, 'b.txt'), 'wip\n')
    run(s.lwt, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'wip'])
    lines.length = 0
    assert.equal(
      await cli(['done', 'agent/x', '-C', s.lwt, '--repo', 'o/r'], {
        client: s.client,
        say,
      }),
      1,
    )
    assert.match(lines.join('\n'), /local only \(not on GitHub\): 1 commit/)
  } finally {
    s.cleanup()
  }
})

/** Someone else renames `from` → `to` on origin's develop. Returns the new develop sha. */
function renameElsewhere(s, from, to) {
  const tmp = join(s.root, `renamer-${from.replace(/\W/g, '_')}`)
  run(s.root, ['clone', '-q', s.bare, tmp])
  run(tmp, ['mv', from, to])
  run(tmp, ['-c', 'commit.gpgsign=false', 'commit', '-qm', `rename ${from}`])
  run(s.bare, ['fetch', '-q', tmp, 'develop:develop'])
  return run(tmp, ['rev-parse', 'HEAD']).trim()
}

/**
 * What `advance` did before `--no-renames`: `reset --soft` onto `target`,
 * restoring only the paths a rename-detecting diff listed — the old path of a
 * rename stays in the index as a staged add.
 */
function strandAcrossRename(dir, target) {
  const old = run(dir, ['rev-parse', 'HEAD']).trim()
  const listed = run(dir, ['diff', '--name-only', '-z', old, target]).split('\0').filter(Boolean)
  run(dir, ['reset', '-q', '--soft', target])
  run(dir, ['restore', `--source=${target}`, '--staged', '--worktree', '--', ...listed])
}

test('advance across a rename on the branch leaves nothing behind', () => {
  const s = scenario()
  try {
    const target = renameElsewhere(s, 'b.txt', 'd/b2.txt')
    run(s.wt, ['fetch', '-q', 'origin', 'develop'])
    must(advance({ git: s.git, target }).advanced)
    assert.equal(run(s.wt, ['status', '--porcelain', '-uall']).trim(), '')
    assert.equal(readFileSync(join(s.wt, 'd/b2.txt'), 'utf8'), 'two\n')
  } finally {
    s.cleanup()
  }
})

test('graft worktree done puts back a path an earlier HEAD left staged, and finishes', async () => {
  const s = await enteredPublishedMerged()
  try {
    writeFileSync(join(s.lwt, '.graft.json'), JSON.stringify({ baseBranch: 'develop' }))
    writeFileSync(join(s.wt, '.git', 'info', 'exclude'), '.graft.json\n')
    const target = renameElsewhere(s, 'b.txt', 'd/b2.txt')
    run(s.lwt, ['fetch', '-q', 'origin', 'develop'])
    strandAcrossRename(s.lwt, target)
    assert.equal(run(s.lwt, ['status', '--porcelain', '-uall']).trim(), 'A  b.txt')

    const lines = []
    const code = await cli(['done', 'agent/x', '-C', s.lwt, '--repo', 'o/r'], {
      client: s.client,
      say: (l) => lines.push(l),
    })
    assert.equal(code, 0, lines.join('\n'))
    assert.match(lines.join('\n'), /Put back 1 path an earlier HEAD left behind[^\n]*\n {2}b\.txt/)
    assert.deepEqual(exitWorktreeCounts(s), { commits: 0, changed: '' })
  } finally {
    s.cleanup()
  }
})

test('tidy leaves a path alone when it was written after HEAD moved, or GitHub lacks the earlier commit', async () => {
  const s = scenario()
  try {
    const target = renameElsewhere(s, 'b.txt', 'd/b2.txt')
    run(s.wt, ['fetch', '-q', 'origin', 'develop'])
    strandAcrossRename(s.wt, target)
    const dirty = ['b.txt']
    assert.deepEqual(
      strayPaths(s.git, dirty).map((x) => x.path),
      ['b.txt'],
    )

    assert.deepEqual(await tidy({ git: s.git, dirty, held: async () => false }), [])
    assert.equal(run(s.wt, ['status', '--porcelain', '-uall']).trim(), 'A  b.txt')

    // The same content, written after the move: somebody's work, not a stray.
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(s.wt, 'b.txt'), later, later)
    assert.deepEqual(await tidy({ git: s.git, dirty, held: async () => true }), [])
    assert.equal(run(s.wt, ['status', '--porcelain', '-uall']).trim(), 'A  b.txt')
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------
// finish-worktree: the same, as a PreToolUse ExitWorktree hook
// ---------------------------------------------------------------------------

const exitEvent = (cwd, input = { action: 'remove' }) => ({ tool_name: 'ExitWorktree', tool_input: input, cwd })

test('finish-worktree: a merged worktree is rewound before ExitWorktree counts, and the remove goes through', async () => {
  const s = await enteredPublishedMerged()
  try {
    writeFileSync(join(s.lwt, '.graft.json'), JSON.stringify({ baseBranch: 'develop' }))
    writeFileSync(join(s.wt, '.git', 'info', 'exclude'), '.graft.json\n')
    assert.ok(exitWorktreeCounts(s).commits >= 2)
    /** @type {string[][]} */
    const calls = []
    const done = (/** @type {string[]} */ argv, /** @type {any} */ o) => {
      calls.push(argv)
      return cli([...argv, '--repo', 'o/r'], { ...o, client: s.client })
    }
    assert.equal(await finish(exitEvent(s.lwt), { done }), null)
    assert.deepEqual(calls, [['done', '-C', s.lwt]])
    assert.deepEqual(exitWorktreeCounts(s), { commits: 0, changed: '' })

    // Local work: denied, with what would be lost.
    writeFileSync(join(s.lwt, 'b.txt'), 'wip\n')
    run(s.lwt, ['add', 'b.txt'])
    run(s.lwt, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'wip'])
    const denied = await finish(exitEvent(s.lwt), { done })
    assert.match(String(denied), /holds work GitHub does not have/)
    assert.match(String(denied), /local only \(not on GitHub\): 1 commit/)
  } finally {
    s.cleanup()
  }
})

test('finish-worktree: no opinion on keep, an explicit discard, no cwd, or when done cannot run', async () => {
  let ran = 0
  const done = async () => {
    ran++
    return 1
  }
  assert.equal(await finish(exitEvent('/w', { action: 'keep' }), { done }), null)
  assert.equal(await finish(exitEvent('/w', { action: 'remove', discard_changes: true }), { done }), null)
  assert.equal(await finish({ tool_input: { action: 'remove' } }, { done }), null)
  assert.equal(ran, 0)
  const throws = async () => {
    throw new Error('main checkout')
  }
  assert.equal(await finish(exitEvent('/w'), { done: throws }), null)
})

test('pr merge finishes its own worktree: rewound before ExitWorktree is ever called', async () => {
  const s = await enteredPublishedMerged()
  try {
    writeFileSync(join(s.lwt, '.graft.json'), JSON.stringify({ baseBranch: 'develop' }))
    writeFileSync(join(s.wt, '.git', 'info', 'exclude'), '.graft.json\n')
    assert.ok(exitWorktreeCounts(s).commits >= 2)
    const head = run(s.lwt, ['rev-parse', 'HEAD']).trim()
    const lines = /** @type {string[]} */ ([])
    const out = await finishAfterMerge({
      git: s.lgit,
      root: s.lwt,
      headSha: head,
      branch: 'agent/x',
      argv: ['merge', '7', '--repo', 'o/r'],
      client: s.client,
      say: (l) => lines.push(l),
    })
    assert.equal(out, 'finished', lines.join('\n'))
    assert.deepEqual(exitWorktreeCounts(s), { commits: 0, changed: '' })
  } finally {
    s.cleanup()
  }
})

test('pr merge leaves alone: the main checkout, a worktree on another head, no repository', async () => {
  const s = await enteredPublishedMerged()
  try {
    let ran = 0
    const done = async () => {
      ran++
      return 0
    }
    const head = run(s.lwt, ['rev-parse', 'HEAD']).trim()
    const say = () => {}
    const main = { git: gitIn(s.wt), root: s.wt, headSha: run(s.wt, ['rev-parse', 'HEAD']).trim() }
    assert.equal(await finishAfterMerge({ ...main, branch: 'agent/x', done, say }), 'skipped')
    assert.equal(
      await finishAfterMerge({ git: s.lgit, root: s.lwt, headSha: 'f'.repeat(40), branch: 'agent/x', done, say }),
      'skipped',
    )
    assert.equal(
      await finishAfterMerge({ git: s.lgit, root: null, headSha: head, branch: 'agent/x', done, say }),
      'skipped',
    )
    assert.equal(ran, 0)
  } finally {
    s.cleanup()
  }
})

test('pr merge: a done that refuses or throws is reported, never thrown', async () => {
  const s = await enteredPublishedMerged()
  try {
    const head = run(s.lwt, ['rev-parse', 'HEAD']).trim()
    for (const done of [async () => 1, async () => Promise.reject(new Error('offline'))]) {
      const lines = /** @type {string[]} */ ([])
      const out = await finishAfterMerge({
        git: s.lgit,
        root: s.lwt,
        headSha: head,
        branch: 'agent/x',
        done,
        say: (l) => lines.push(l),
      })
      assert.equal(out, 'failed')
      assert.match(lines.join('\n'), /run `graft worktree done agent\/x`/)
    }
  } finally {
    s.cleanup()
  }
})
