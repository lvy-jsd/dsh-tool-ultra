/**
 * Tool Ultra Code Insight pack:
 * Semantic AST outline, symbol extraction, and call graphs for TS/JS, Python, Rust, and Go.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractOutline, detectLanguage, type CodeOutlineResult, type SymbolItem } from './parser.js'

export {
  extractOutline,
  detectLanguage,
  type CodeOutlineResult,
  type SymbolItem,
}

export const name = 'tool-ultra-pack-code-insight'
export const inject = ['tools']

export interface Config {
  disable?: string[]
  maxDepth?: number
  maxSymbols?: number
}

export const TOOL_NAMES = ['code_outline', 'code_symbols', 'code_callgraph'] as const

const DEFAULTS = {
  maxDepth: 3,
  maxSymbols: 200,
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

function formatSymbol(sym: SymbolItem, indent = 0, maxDepth = 3): string {
  if (indent >= maxDepth) return ''
  const pad = '  '.repeat(indent)
  const lineStr = `(L${sym.line})`
  const sig = sym.signature || `${sym.kind} ${sym.name}`
  let out = `${pad}- ${lineStr} ${sig}\n`

  if (sym.children && sym.children.length > 0 && indent + 1 < maxDepth) {
    for (const child of sym.children) {
      out += formatSymbol(child, indent + 1, maxDepth)
    }
  }
  return out
}

export function createTools(config: Config = {}) {
  const defaultDepth = config.maxDepth ?? DEFAULTS.maxDepth
  const defaultMaxSymbols = config.maxSymbols ?? DEFAULTS.maxSymbols

  return [
    {
      name: 'code_outline' as const,
      description:
        'Extract a clean structural AST outline of a source code file (classes, functions, methods, interfaces, imports, exports) without loading full bodies, saving 90% of model tokens. Supports TypeScript, JavaScript, Python, Rust, and Go.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Local file path to the source file.',
        },
        max_depth: {
          type: 'integer',
          description: `Maximum depth of nested symbols to show (default: ${defaultDepth}).`,
        },
      },
      async execute(args: { path: string; max_depth?: number }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('File path cannot be empty.')
        }
        if (!existsSync(args.path)) {
          throw new Error(`[Code Insight Error] File not found: "${args.path}"`)
        }

        try {
          const code = await readFile(args.path, 'utf8')
          const depth = args.max_depth ?? defaultDepth
          const outline = extractOutline(code, args.path)

          const lines: string[] = [
            `Outline: ${outline.filename} (${outline.language})`,
            '',
          ]

          if (outline.imports.length > 0) {
            lines.push(`Imports (${outline.imports.length}):`)
            for (const imp of outline.imports.slice(0, 20)) {
              lines.push(`  import ${imp}`)
            }
            if (outline.imports.length > 20) {
              lines.push(`  ... and ${outline.imports.length - 20} more imports`)
            }
            lines.push('')
          }

          if (outline.exports.length > 0) {
            lines.push(`Exports (${outline.exports.length}):`)
            for (const exp of outline.exports) {
              lines.push(`  export ${exp}`)
            }
            lines.push('')
          }

          lines.push(`Symbols (${outline.symbols.length}):`)
          if (outline.symbols.length === 0) {
            lines.push('  (no top-level classes or functions detected)')
          } else {
            for (const sym of outline.symbols) {
              lines.push(formatSymbol(sym, 1, depth).trimEnd())
            }
          }

          return lines.join('\n')
        } catch (err: any) {
          throw new Error(`[Code Insight Error] Failed to generate outline for "${args.path}": ${err.message}`)
        }
      },
    },
    {
      name: 'code_symbols' as const,
      description:
        'Search or list definitions (functions, classes, interfaces, structs) in a file or directory without reading file bodies.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to a file or directory.',
        },
        query: {
          type: 'string',
          description: 'Optional name filter to search for specific symbols.',
        },
      },
      async execute(args: { path: string; query?: string }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('Path cannot be empty.')
        }
        if (!existsSync(args.path)) {
          throw new Error(`[Code Insight Error] Path not found: "${args.path}"`)
        }

        const files: string[] = []
        async function collect(p: string) {
          const s = await stat(p)
          if (s.isDirectory()) {
            const entries = await readdir(p)
            for (const e of entries) {
              if (['node_modules', '.git', 'dist', 'build', '.cache'].includes(e)) continue
              await collect(join(p, e))
            }
          } else if (s.isFile()) {
            const lang = detectLanguage(p)
            if (lang !== 'generic') files.push(p)
          }
        }

        await collect(args.path)

        const q = args.query?.toLowerCase()
        const found: { file: string; symbol: SymbolItem }[] = []

        function searchSymbols(file: string, items: SymbolItem[]) {
          for (const item of items) {
            if (!q || item.name.toLowerCase().includes(q)) {
              found.push({ file, symbol: item })
            }
            if (item.children) searchSymbols(file, item.children)
          }
        }

        for (const f of files.slice(0, 50)) {
          try {
            const content = await readFile(f, 'utf8')
            const outline = extractOutline(content, f)
            searchSymbols(f, outline.symbols)
          } catch {
            // Ignore unparseable files
          }
        }

        if (found.length === 0) {
          return `No symbols found${q ? ` matching "${q}"` : ''} in ${args.path}.`
        }

        const count = found.length
        const display = found.slice(0, defaultMaxSymbols)
        const lines = [
          `Found ${count} symbol(s)${q ? ` matching "${q}"` : ''}:`,
          '',
        ]

        for (const item of display) {
          lines.push(`- [${item.symbol.kind}] ${item.symbol.name} -> ${item.file}:${item.symbol.line}`)
        }

        if (count > defaultMaxSymbols) {
          lines.push(`\n[... truncated ${count - defaultMaxSymbols} additional symbols]`)
        }
        return lines.join('\n')
      },
    },
    {
      name: 'code_callgraph' as const,
      description:
        'Trace module dependencies and import relationships for a file or directory.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to source file or project folder.',
        },
      },
      async execute(args: { path: string }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('Path cannot be empty.')
        }
        if (!existsSync(args.path)) {
          throw new Error(`[Code Insight Error] Path not found: "${args.path}"`)
        }

        const fileGraph: { file: string; imports: string[] }[] = []

        async function collect(p: string) {
          const s = await stat(p)
          if (s.isDirectory()) {
            const entries = await readdir(p)
            for (const e of entries) {
              if (['node_modules', '.git', 'dist', 'build', '.cache'].includes(e)) continue
              await collect(join(p, e))
            }
          } else if (s.isFile()) {
            const lang = detectLanguage(p)
            if (lang !== 'generic') {
              try {
                const code = await readFile(p, 'utf8')
                const outline = extractOutline(code, p)
                if (outline.imports.length > 0) {
                  fileGraph.push({ file: p, imports: outline.imports })
                }
              } catch {
                // Ignore parse failures
              }
            }
          }
        }

        await collect(args.path)

        if (fileGraph.length === 0) {
          return `No module dependency graph found for ${args.path}.`
        }

        const lines = [`Dependency Graph (${fileGraph.length} modules):`, '']
        for (const item of fileGraph.slice(0, 40)) {
          lines.push(`Module: ${item.file}`)
          for (const imp of item.imports.slice(0, 10)) {
            lines.push(`  -> ${imp}`)
          }
          if (item.imports.length > 10) {
            lines.push(`  ... and ${item.imports.length - 10} more imports`)
          }
          lines.push('')
        }

        return lines.join('\n')
      },
    },
  ]
}

export function apply(ctx: any, config: Config = {}) {
  const disabled = new Set(config.disable ?? [])

  if (typeof ctx.inject === 'function') {
    ctx.inject(['toolCatalog'], (c: any) => {
      if (typeof c.toolCatalog?.registerToolPack !== 'function') return
      c.effect(() =>
        c.toolCatalog.registerToolPack({
          id: 'code-insight',
          title: 'Code Insight & Outline',
          summary: 'Semantic AST outlines, symbol extraction, and module dependency graphs for TS/JS, Python, Rust, and Go.',
          source: '@lvy-jsd/dsh-tool-ultra-pack-code-insight',
          tools: TOOL_NAMES.filter((n) => !disabled.has(n)),
        }),
      )
    })
  }

  for (const spec of createTools(config)) {
    if (disabled.has(spec.name)) continue
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => true,
        execute: (args: unknown) => spec.execute(args as any),
      } as any),
    )
  }
}
