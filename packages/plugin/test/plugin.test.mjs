import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..', '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const json = (p) => JSON.parse(read(p))
const skillsDir = join(root, 'skills')
const skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())

/** `---` frontmatter of flat `key: value` lines (biome may put a blank line after the opening fence). */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(m, 'frontmatter fenced by ---')
  const fields = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2]
  }
  return { fields, body: text.slice(m[0].length) }
}

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

test('Claude Code and Kiro manifests describe the same plugin', () => {
  const claude = json('.claude-plugin/plugin.json')
  const kiro = json('plugin.json')
  assert.equal(claude.name, 'oakgreen')
  assert.equal(kiro.name, claude.name)
  assert.equal(kiro.version, claude.version)
  assert.equal(kiro.description, claude.description)
  assert.match(claude.version, /^\d+\.\d+\.\d+$/)
})

test('Kiro power manifest has every field Kiro requires', () => {
  const kiro = json('plugin.json')
  assert.equal(kiro.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.match(kiro.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.ok(kiro.description.length > 0)
  assert.ok(kiro.author?.name)
  assert.ok(Array.isArray(kiro.keywords) && kiro.keywords.length > 0)
  assert.ok(kiro.keywords.every((k) => typeof k === 'string'))
})

test('the root marketplace lists the plugin', () => {
  const market = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const entry = market.plugins.find((p) => p.name === 'oakgreen')
  assert.ok(entry, 'oakgreen in marketplace.json')
  assert.equal(entry.source, './packages/plugin')
})

test('each skill follows the Agent Skills format both tools read', () => {
  assert.ok(skills.includes('oakgreen-setup'))
  for (const name of skills) {
    const { fields, body } = frontmatter(read(join('skills', name, 'SKILL.md')))
    assert.equal(fields.name, name, 'name matches its folder')
    assert.match(name, /^[a-z0-9-]{1,64}$/)
    assert.ok(fields.description && fields.description.length <= 1024, `${name}: description 1..1024 chars`)
    assert.ok(body.split('\n').length < 500, `${name}: SKILL.md under 500 lines`)
  }
})

test('relative links in skill files resolve', () => {
  for (const file of walk(skillsDir).filter((f) => f.endsWith('.md') && !f.includes(`${join('evals', '')}`))) {
    const text = readFileSync(file, 'utf8')
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target) || target.startsWith('#')) continue
      const path = join(dirname(file), target.split('#')[0])
      assert.ok(existsSync(path), `${relative(root, file)} links to missing ${target}`)
    }
  }
})

test('every oakgreen command the skill names is one the CLI has', () => {
  const require = createRequire(import.meta.url)
  const bin = join(dirname(require.resolve('oakgreen/package.json')), 'bin', 'oakgreen.mjs')
  const usage = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' })
  const verbs = new Set([...usage.matchAll(/^\s+oakgreen (\w+)/gm)].map((m) => m[1]))
  for (const tool of /run (.+)$/m.exec(usage)[1].split(', ')) verbs.add(tool.trim())
  for (const v of ['setup', 'doctor', 'start', 'services', 'reload', 'graft', 'cambium']) assert.ok(verbs.has(v), v)

  const files = walk(skillsDir).filter((f) => f.endsWith('.md') && !f.includes(join('evals', '')))
  for (const file of files) {
    for (const [, verb] of readFileSync(file, 'utf8').matchAll(/`oakgreen ([a-z]+)\b/g)) {
      assert.ok(verbs.has(verb), `${relative(root, file)}: oakgreen ${verb} is not a command`)
    }
  }
})

test('the skill drives the oakgreen CLI and ships no install scripts of its own', () => {
  const skill = read('skills/oakgreen-setup/SKILL.md')
  for (const cmd of ['oakgreen doctor', 'oakgreen setup --dry-run', 'oakgreen start', 'oakgreen services']) {
    assert.ok(skill.includes(cmd), `SKILL.md uses ${cmd}`)
  }
  const scripts = walk(join(skillsDir, 'oakgreen-setup')).filter((f) => /\.(sh|mjs|js|py)$/.test(f))
  assert.deepEqual(scripts, [])
})

test('evals: wizard cases load in the claude plugin eval layout, and a trigger set', () => {
  const evals = join(skillsDir, 'oakgreen-setup', 'evals')
  const cases = readdirSync(evals).filter((d) => statSync(join(evals, d)).isDirectory())
  assert.ok(cases.length >= 3, 'at least three wizard cases')
  const allowed = new Set(['tags', 'max_turns', 'timeout_seconds', 'allowed_tools'])
  for (const c of cases) {
    const dir = join(evals, c)
    const { fields, body } = frontmatter(readFileSync(join(dir, 'prompt.md'), 'utf8'))
    for (const k of Object.keys(fields)) assert.ok(allowed.has(k), `${c}: unknown prompt setting ${k}`)
    assert.ok(body.trim().length > 0, `${c}: prompt`)
    const yaml = readFileSync(join(dir, 'case.yaml'), 'utf8')
    assert.match(yaml, /^schema_version: "1\.1"$/m)
    assert.match(yaml, new RegExp(`^name: ${c}$`, 'm'))
    assert.match(yaml, /^expected_outcome: \|$/m)
    const graders = readdirSync(join(dir, 'graders')).filter((f) => f.endsWith('.md'))
    assert.ok(graders.length > 0, `${c}: graders`)
    for (const g of graders) {
      const { fields: gf, body: gb } = frontmatter(readFileSync(join(dir, 'graders', g), 'utf8'))
      assert.equal(gf.type, 'llm')
      assert.ok(gb.trim(), `${c}/${g}: statement`)
    }
  }
  const trigger = JSON.parse(readFileSync(join(evals, 'trigger-eval.json'), 'utf8'))
  assert.ok(trigger.every((q) => typeof q.query === 'string' && typeof q.should_trigger === 'boolean'))
  assert.ok(trigger.filter((q) => q.should_trigger).length >= 8)
  assert.ok(trigger.filter((q) => !q.should_trigger).length >= 8)
})

test('/oakgreen:decide: a command that hands its argument to the oakgreen-decide skill', () => {
  const { fields, body } = frontmatter(read('commands/decide.md'))
  assert.ok(fields.description, 'description')
  assert.equal(fields['argument-hint'], '<owner/repo#n>')
  assert.match(body, /`oakgreen-decide` skill/)
  assert.match(body, /\$ARGUMENTS/)
  assert.ok(json('package.json').files.includes('commands/'), 'the command ships')
})

test('oakgreen-decide: drives the cambium decide verbs that exist, with both lens templates and the session rules', () => {
  const require = createRequire(import.meta.url)
  const bin = join(dirname(require.resolve('@oakgreencc/cambium/package.json')), 'bin', 'cambium.mjs')
  const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8', env: { ...process.env } })
  const verbs = new Set([...help.matchAll(/^\s+cambium decide (\w+)/gm)].map((m) => m[1]))
  const skill = read('skills/oakgreen-decide/SKILL.md')
  const files = walk(join(skillsDir, 'oakgreen-decide')).filter((f) => f.endsWith('.md'))
  for (const file of files)
    for (const [, verb] of readFileSync(file, 'utf8').matchAll(/`cambium decide ([a-z]+)\b/g))
      assert.ok(verbs.has(verb), `${relative(root, file)}: cambium decide ${verb} is not a command`)
  for (const cmd of ['cambium decide show', 'cambium decide advance']) assert.ok(skill.includes(cmd), cmd)
  for (const node of ['open', 'orient', 'mock', 'ask-round', 'await-answers', 'apply-answers', 'draft', 'confirm'])
    assert.match(skill, new RegExp(`^\\| \`${node}\` +\\| `, 'm'), `per-node instructions for ${node}`)
  assert.match(skill, /Decisions are the person's; facts are yours/)
  assert.match(skill, /At most 5 numbered questions per round/)
  assert.match(skill, /## Completeness/)
  const product = read('skills/oakgreen-decide/references/product.md')
  assert.match(product, /## Glossary checks/)
  assert.match(product, /brief-shaped/)
  assert.match(read('skills/oakgreen-decide/references/technical.md'), /ADR-shaped/)
})
