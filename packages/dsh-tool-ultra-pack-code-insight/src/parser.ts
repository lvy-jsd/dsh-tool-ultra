/**
 * JavaScript / TypeScript structural parser (not semantic type resolution)
 */
import { parse as parseBabel } from '@babel/parser'
import { extname } from 'node:path'

export interface SymbolItem {
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'import' | 'export' | 'struct' | 'enum' | 'trait'
  name: string
  line: number
  signature?: string
  children?: SymbolItem[]
}

export interface CodeOutlineResult {
  filename: string
  language: string
  symbols: SymbolItem[]
  imports: string[]
  exports: string[]
}

export function detectLanguage(filename: string): string {
  const ext = extname(filename).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.tsx':
      return 'typescript-react'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.jsx':
      return 'javascript-react'
    default:
      return 'generic'
  }
}

/** Parses TypeScript and JavaScript source code into a clean AST outline */
function parseJsTs(code: string, filename: string): CodeOutlineResult {
  const isTs = detectLanguage(filename).startsWith('typescript')
  const isJsx = /\.[jt]sx$/i.test(filename)

  const ast = parseBabel(code, {
    sourceType: 'unambiguous',
    plugins: [
      ...(isTs ? ['typescript' as const] : []),
      ...(isJsx ? ['jsx' as const] : []),
      'classProperties',
      'decorators-legacy',
      'exportDefaultFrom',
      'dynamicImport',
    ],
    errorRecovery: false,
  })

  const symbols: SymbolItem[] = []
  const imports: string[] = []
  const exports: string[] = []

  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value
      const specs = node.specifiers.map((s: any) => s.local?.name || '').filter(Boolean).join(', ')
      imports.push(specs ? `{ ${specs} } from '${source}'` : `'${source}'`)
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        addJsTsDeclaration(node.declaration, symbols, code)
        if ('id' in node.declaration && (node.declaration as any).id?.name) {
          exports.push((node.declaration as any).id.name)
        } else if (node.declaration.type === 'VariableDeclaration') {
          for (const v of (node.declaration as any).declarations) {
            if (v.id?.name) exports.push(v.id.name)
          }
        }
      } else if (node.specifiers) {
        for (const spec of node.specifiers) {
          if ('exported' in spec && 'name' in spec.exported) {
            exports.push(spec.exported.name)
          }
        }
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration
      const name = 'id' in decl && decl.id ? (decl.id as any).name : 'default'
      exports.push(`default: ${name}`)
      if ('type' in decl) {
        addJsTsDeclaration(decl as any, symbols, code)
      }
    } else {
      addJsTsDeclaration(node, symbols, code)
    }
  }

  return {
    filename,
    language: detectLanguage(filename),
    symbols,
    imports,
    exports,
  }
}

function addJsTsDeclaration(decl: any, list: SymbolItem[], code: string) {
  const line = decl.loc?.start.line ?? 0

  if (decl.type === 'FunctionDeclaration' && decl.id) {
    const params = decl.params.map((p: any) => code.slice(p.start, p.end)).join(', ')
    const asyncPrefix = decl.async ? 'async ' : ''
    list.push({
      kind: 'function',
      name: decl.id.name,
      line,
      signature: `${asyncPrefix}function ${decl.id.name}(${params})`,
    })
  } else if (decl.type === 'ClassDeclaration' && decl.id) {
    const methods: SymbolItem[] = []
    if (decl.body?.body) {
      for (const m of decl.body.body) {
        if (m.type === 'ClassMethod' && m.key?.name) {
          const mLine = m.loc?.start.line ?? line
          const mParams = m.params.map((p: any) => code.slice(p.start, p.end)).join(', ')
          const prefix = `${m.static ? 'static ' : ''}${m.async ? 'async ' : ''}`
          methods.push({
            kind: 'method',
            name: m.key.name,
            line: mLine,
            signature: `${prefix}${m.key.name}(${mParams})`,
          })
        }
      }
    }
    list.push({
      kind: 'class',
      name: decl.id.name,
      line,
      signature: `class ${decl.id.name}${decl.superClass ? ` extends ${(decl.superClass as any).name || ''}` : ''}`,
      children: methods,
    })
  } else if (decl.type === 'TSInterfaceDeclaration' && decl.id) {
    list.push({
      kind: 'interface',
      name: decl.id.name,
      line,
      signature: `interface ${decl.id.name}`,
    })
  } else if (decl.type === 'TSTypeAliasDeclaration' && decl.id) {
    list.push({
      kind: 'type',
      name: decl.id.name,
      line,
      signature: `type ${decl.id.name}`,
    })
  } else if (decl.type === 'VariableDeclaration') {
    for (const v of decl.declarations) {
      if (v.id?.name) {
        list.push({
          kind: 'variable',
          name: v.id.name,
          line,
          signature: `${decl.kind} ${v.id.name}`,
        })
      }
    }
  }
}

/** Only JavaScript and TypeScript are supported; never fabricate an empty outline. */
export function extractOutline(code: string, filename: string): CodeOutlineResult {
  if (detectLanguage(filename) === 'generic') throw new Error('Only JavaScript / TypeScript files are supported.')
  return parseJsTs(code, filename)
}
