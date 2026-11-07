// Discover build entry points, not node_modules or arbitrary nested configs.
// Generated solution stays local; adding a package never edits a tracked list.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const generatedName = 'tsconfig.projects.generated.json'
const entries = ['tsconfig.json', 'tsconfig.client.json']

export async function discoverProjects(workspace = root) {
  const projects = []
  const packages = await readdir(join(workspace, 'packages'), { withFileTypes: true })
  for (const pkg of packages.filter(p => p.isDirectory()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const files = await readdir(join(workspace, 'packages', pkg.name), { withFileTypes: true })
    if (!files.some(f => f.name === 'package.json' && f.isFile())) continue
    for (const entry of entries) {
      if (files.some(f => f.name === entry && f.isFile())) projects.push({ path: `./packages/${pkg.name}/${entry}` })
    }
  }
  return projects
}

export async function generateProjects(workspace = root) {
  const references = await discoverProjects(workspace)
  if (!references.length) throw new Error('No TypeScript workspace build projects found.')
  const content = JSON.stringify({ files: [], references }, null, 2) + '\n'
  const target = join(workspace, generatedName)
  let previous
  try { previous = await readFile(target, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  // Preserve timestamps so an unchanged solution does not invalidate editor/build caches.
  if (previous !== content) await writeFile(target, content)
  return { references, changed: previous !== content }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateProjects()
  console.log(`TypeScript solution: ${result.references.length} projects (${result.changed ? 'updated' : 'unchanged'})`)
}
