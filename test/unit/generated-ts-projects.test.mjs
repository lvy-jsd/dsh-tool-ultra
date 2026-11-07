import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { discoverProjects, generateProjects, generatedName } from '../../scripts/generate-ts-projects.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ts projects with spaces-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'packages'))
  return root
}

async function add(root, name, files) {
  const dir = join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}')
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content)
}

test('ts projects: deterministic discovery includes browser entries, excludes other configs and nested dependencies', async (t) => {
  const root = await fixture(t)
  await add(root, 'z-server', { 'tsconfig.json': '{}' })
  await add(root, 'a-panel', { 'tsconfig.json': '{}', 'tsconfig.client.json': '{}', 'tsconfig.test.json': '{}' })
  await mkdir(join(root, 'packages', 'z-server', 'node_modules', 'nested'), { recursive: true })
  await writeFile(join(root, 'packages', 'z-server', 'node_modules', 'nested', 'tsconfig.json'), '{}')
  await mkdir(join(root, 'packages', 'not-a-package'))
  await writeFile(join(root, 'packages', 'not-a-package', 'tsconfig.json'), '{}')
  const refs = await discoverProjects(root)
  assert.deepEqual(refs.map(r => r.path), [
    './packages/a-panel/tsconfig.json', './packages/a-panel/tsconfig.client.json', './packages/z-server/tsconfig.json',
  ])
  assert.equal((await generateProjects(root)).changed, true)
  const time = (await stat(join(root, generatedName))).mtimeMs
  assert.equal((await generateProjects(root)).changed, false)
  assert.equal((await stat(join(root, generatedName))).mtimeMs, time)
  assert.deepEqual(JSON.parse(await readFile(join(root, generatedName), 'utf8')).references, refs)
})

test('ts projects: package creation/removal updates solution without shared-list edits', async (t) => {
  const root = await fixture(t)
  await add(root, 'one', { 'tsconfig.json': '{}' })
  await generateProjects(root)
  await add(root, 'two', { 'tsconfig.json': '{}', 'tsconfig.client.json': '{}' })
  assert.equal((await generateProjects(root)).references.length, 3)
  const source = join(root, 'packages', 'one')
  const target = join(root, 'removed-one')
  assert.equal(source, join(root, 'packages', 'one'))
  assert.equal(target, join(root, 'removed-one'))
  await rename(source, target)
  assert.equal((await generateProjects(root)).references.length, 2)
})

test('ts projects: generated solution performs a real tsc build in a path containing spaces', async (t) => {
  const root = await fixture(t)
  await add(root, 'new-pack', {
    'tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, outDir: 'lib', rootDir: 'src' }, include: ['src'] }),
  })
  await mkdir(join(root, 'packages', 'new-pack', 'src'))
  await writeFile(join(root, 'packages', 'new-pack', 'src', 'index.ts'), 'export const answer: number = 42\n')
  await generateProjects(root)
  const tsc = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
  const result = spawnSync(process.execPath, [tsc, '-b', join(root, generatedName)], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(await readFile(join(root, 'packages', 'new-pack', 'lib', 'index.js'), 'utf8'), /42/)
})

test('ts projects: refuses an empty workspace instead of reporting a false successful build', async (t) => {
  const root = await fixture(t)
  await assert.rejects(generateProjects(root), /No TypeScript workspace build projects/)
})
