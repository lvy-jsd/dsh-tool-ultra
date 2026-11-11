#!/usr/bin/env node
// create-dsh-tool-ultra-plugin: generate a working Tool Ultra extension.
//
//   npm create @lvy-jsd/dsh-tool-ultra-plugin@latest my-ext -- --type classifier
//   node packages/create-dsh-tool-ultra-plugin/lib/cli.js my-ext --type filter
//
// Types map to the four extension points:
//   classifier  registerClassifier — place tools into groups and categories
//   filter      registerVisibilityFilter — narrow what one agent may see
//   hook        a tool-catalog/* event listener (audit, quota, statistics)
//   declaration a package.json `dsh.toolCatalog` block, zero code
//
// The generated package is complete: package.json, cordis.patch.yml, lib/index.js,
// README.md, LICENSE and a test that loads the plugin and asserts its effect.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const TYPES = ['classifier', 'filter', 'hook', 'declaration']

export interface Args {
  name?: string
  type: string
  dir?: string
  help?: boolean
}

export interface ScaffoldOptions {
  name?: string
  type?: string
  dir?: string
  logger?(line: string): void
}

export interface ScaffoldResult {
  dir: string
  package: string
  type: string
  files: string[]
}

const YEAR = new Date().getFullYear()

const kebab = (value: unknown): string => String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const PACKAGE_JSON = (name: string, type: string): string => `${JSON.stringify({
  name,
  version: '0.1.0',
  private: true,
  description: `A Tool Ultra ${type} extension.`,
  license: 'MIT',
  type: 'module',
  main: 'lib/index.js',
  exports: { '.': './lib/index.js', './package.json': './package.json' },
  scripts: { test: 'node --test test/*.test.mjs' },
  peerDependencies: { '@lvy-jsd/dsh-tool-ultra-core': '>=0.5.0' },
  ...(type === 'declaration' ? { dsh: { bundle: { patch: './cordis.patch.yml' }, toolCatalog: { match: '^my_', category: 'vendor' } } } : { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
}, null, 2)}\n`

const PATCH = (name: string, type: string): string => `# ${name} bundle patch: one loader entry.
- insert:
    - id: ${name}
      name: ${name}
${type === 'declaration' ? '' : `      config: {}
`}`

const LIB = (name: string, type: string): string => {
  if (type === 'classifier') {
    return `// ${name}: place tools into groups and categories.
//
// A classifier runs while the directory is built and must answer synchronously.
// Priorities: >= 1000 beats plugin declarations (user overrides); < 1000 is
// beaten by them.

export const name = ${JSON.stringify(name)}
export const inject = ['toolCatalog']

export const PRIORITY = 200

export function apply(ctx, config = {}) {
  const prefix = config.prefix ?? 'my_'
  const group = config.group ?? 'mine'

  ctx.effect(() => ctx.toolCatalog.registerClassifier({
    name: '${name}',
    priority: PRIORITY,
    group(tool) {
      return tool.name.startsWith(prefix) ? group : undefined
    },
    categorize(candidate) {
      // Return a category name for a group, or undefined to let others decide.
      return candidate.name === group ? (config.category ?? 'vendor') : undefined
    },
  }), '${name}.register()')
}

export default { name, inject, apply }
`
  }
  if (type === 'filter') {
    return `// ${name}: narrow what one agent may see.
//
// A visibility filter runs last and can only REMOVE names. It cannot add a tool
// the core hid, and it cannot hide the entry tools.

export const name = ${JSON.stringify(name)}
export const inject = ['toolCatalog']

export function apply(ctx, config = {}) {
  const hidden = new Set(config.hide ?? [])

  ctx.effect(() => ctx.toolCatalog.registerVisibilityFilter({
    name: '${name}',
    filter(_agent, names) {
      if (hidden.size === 0) return names
      return names.filter((toolName) => !hidden.has(toolName))
    },
  }), '${name}.register()')
}

export default { name, inject, apply }
`
  }
  if (type === 'hook') {
    return `// ${name}: observe loads and unloads (audit, quotas, statistics).
//
// Hooks are plain Cordis events on the host context. Throwing from a
// "before-*" event vetoes the action, so only throw when you mean to refuse it.

export const name = ${JSON.stringify(name)}
export const inject = ['toolCatalog']

export function apply(ctx, config = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('${name}') : ctx.logger) ?? console

  ctx.effect(() => ctx.on('tool-catalog/after-load', ({ agent, added }) => {
    logger.info?.(\`\${agent?.id ?? '?'} loaded \${added.length} tool(s)\`)
  }), '${name}.after-load()')

  ctx.effect(() => ctx.on('tool-catalog/after-unload', ({ agent, removed }) => {
    logger.info?.(\`\${agent?.id ?? '?'} unloaded \${removed.length} tool(s)\`)
  }), '${name}.after-unload()')

  // To refuse a load instead, listen to the serial event and throw:
  //   ctx.on('tool-catalog/before-load', ({ names }) => {
  //     if (names.length > 50) throw new Error('too many tools at once')
  //   })
}

export default { name, inject, apply }
`
  }
  return `// ${name}: declared entirely in package.json, with no code.
//
// The \`dsh.toolCatalog\` block in package.json places tools:
//
//   "toolCatalog": { "match": "^my_", "category": "vendor",
//                    "tools": { "my_danger": { "risk": "high" } } }
//
// Self-declaration is the most accurate source: it beats built-in rules and the
// small-model classifier, and only user overrides (priority 1000) beat it.

export const name = ${JSON.stringify(name)}

export default { name }
`
}

const README = (name: string, type: string): string => `# ${name}

A [\`Tool Ultra\`](https://github.com/lvy-jsd/dsh-tool-ultra) **${type}** extension.

## Install

\`\`\`sh
dsh plugin --profile web add @lvy-jsd/dsh-tool-ultra-core ${name}
\`\`\`

Then restart DSH, or let live reload pick it up.

## Configure

\`\`\`yaml
- id: ${name}
  name: ${name}
  config: {}
\`\`\`

## Develop

\`\`\`sh
npm test
\`\`\`

The extension points are documented in the core README:
${type === 'classifier' ? '`registerClassifier` — place tools into groups and categories.'
  : type === 'filter' ? '`registerVisibilityFilter` — narrow what one agent may see.'
  : type === 'hook' ? 'the `tool-catalog/*` events — observe or veto loads.'
  : 'the `dsh.toolCatalog` block in package.json — declare metadata without code.'}

## License

MIT — see [LICENSE](LICENSE).
`

const TEST = (name: string, type: string): string => {
  const importPath = `../lib/index.js`
  if (type === 'declaration') {
    return `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('${name}: declares tool metadata in package.json', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh?.toolCatalog, 'has a dsh.toolCatalog block')
  assert.equal(typeof manifest.dsh.toolCatalog.match, 'string')
})
`
  }
  return `import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '${importPath}'

/** Minimal context: effects run immediately, registrations are captured. */
function makeCtx() {
  const seen = { classifiers: [], filters: [], listeners: new Map() }
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    effect: (fn) => fn(),
    on: (event, handler) => { seen.listeners.set(event, handler); return () => {} },
    toolCatalog: {
      registerClassifier: (c) => { seen.classifiers.push(c); return () => {} },
      registerVisibilityFilter: (f) => { seen.filters.push(f); return () => {} },
      defineCategory: () => () => {},
      refresh() {},
    },
  }
  return { ctx, seen }
}

test('${name}: exports a plugin with a name and inject list', () => {
  assert.equal(typeof plugin.name, 'string')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.apply, 'function')
})

${type === 'classifier' ? `test('${name}: registers a classifier that places its tools', () => {
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx, {})
  assert.equal(seen.classifiers.length, 1)
  const classifier = seen.classifiers[0]
  assert.equal(classifier.group({ name: 'my_tool' }), 'mine')
  assert.equal(classifier.group({ name: 'other' }), undefined)
})` : type === 'filter' ? `test('${name}: registers a filter that only removes names', () => {
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx, { hide: ['secret_tool'] })
  assert.equal(seen.filters.length, 1)
  const kept = seen.filters[0].filter({}, ['a', 'secret_tool'])
  assert.deepEqual(kept, ['a'])
})` : `test('${name}: subscribes to the load hooks', () => {
  const { ctx, seen } = makeCtx()
  plugin.apply(ctx, {})
  assert.ok(seen.listeners.has('tool-catalog/after-load'))
  assert.ok(seen.listeners.has('tool-catalog/after-unload'))
})`}
`
}

const LICENSE = (name: string): string => `MIT License

Copyright (c) ${YEAR} ${name} contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

export const USAGE = `create-dsh-tool-ultra-plugin <name> [--type ${TYPES.join('|')}] [--dir <path>]

  name   package name of the new extension (kebab-case)
  --type one of: ${TYPES.join(', ')} (default: classifier)
  --dir  where to create it (default: ./<name>)
`

export function parseArgs(argv: string[]): Args {
  const args: Args = { type: 'classifier' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--type') { args.type = argv[++i]; continue }
    if (arg === '--dir') { args.dir = argv[++i]; continue }
    if (arg === '--help' || arg === '-h') { args.help = true; continue }
    if (!arg.startsWith('-') && args.name === undefined) { args.name = arg; continue }
    throw new Error(`unexpected argument: ${arg}`)
  }
  return args
}

/**
 * Write a complete extension package.
 * @returns the list of files written, relative to the target directory.
 */
export function scaffold({ name, type = 'classifier', dir, logger }: ScaffoldOptions = {}): ScaffoldResult {
  if (!name) throw new Error('a package name is required')
  if (!TYPES.includes(type)) throw new Error(`unknown type "${type}"; expected one of: ${TYPES.join(', ')}`)
  const pkg = kebab(name)
  if (pkg.length === 0) throw new Error(`"${name}" is not a usable package name`)
  const target = resolve(dir ?? pkg)
  if (existsSync(target) && existsSync(join(target, 'package.json'))) {
    throw new Error(`${target} already contains a package.json; refusing to overwrite`)
  }
  const files: Record<string, string> = {
    'package.json': PACKAGE_JSON(pkg, type),
    'cordis.patch.yml': PATCH(pkg, type),
    'README.md': README(pkg, type),
    'LICENSE': LICENSE(pkg),
    [`test/${pkg}.test.mjs`]: TEST(pkg, type),
  }
  if (type !== 'declaration') files['lib/index.js'] = LIB(pkg, type)
  for (const [rel, body] of Object.entries(files)) {
    const path = join(target, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    logger?.(`created ${rel}`)
  }
  return { dir: target, package: pkg, type, files: Object.keys(files) }
}

export function main(argv: string[] = process.argv.slice(2), log: (line: string) => void = console.log): number {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (caught) {
    const error = caught as Error
    log(`error: ${error.message}`)
    log(USAGE)
    return 2
  }
  if (args.help) {
    log(USAGE)
    return 0
  }
  try {
    const result = scaffold({ ...args, logger: log })
    log(`\n${result.package} (${result.type}) created in ${result.dir}`)
    log(`  next: cd ${result.dir} && npm test`)
    return 0
  } catch (caught) {
    const error = caught as Error
    log(`error: ${error.message}`)
    return 1
  }
}

export default { scaffold, parseArgs, main, TYPES }
