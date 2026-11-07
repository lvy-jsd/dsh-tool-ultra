/**
 * Multi-language Code Outline & Symbol Parser
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
    case '.py':
      return 'python'
    case '.rs':
      return 'rust'
    case '.go':
      return 'go'
    default:
      return 'generic'
  }
}

/** Parses TypeScript and JavaScript source code into a clean AST outline */
function parseJsTs(code: string, filename: string): CodeOutlineResult {
  const isTs = filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.mts')
  const isJsx = filename.endsWith('.tsx') || filename.endsWith('.jsx')

  const ast = parseBabel(code, {
    sourceType: 'module',
    plugins: [
      isTs ? 'typescript' : 'flow',
      ...(isJsx ? ['jsx' as const] : []),
      'classProperties',
      'decorators-legacy',
      'exportDefaultFrom',
      'dynamicImport',
    ],
    errorRecovery: true,
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
        addJsTsDeclaration(node.declaration, symbols, code, true)
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
        addJsTsDeclaration(decl as any, symbols, code, true)
      }
    } else {
      addJsTsDeclaration(node, symbols, code, false)
    }
  }

  return {
    filename,
    language: isTs ? 'typescript' : 'javascript',
    symbols,
    imports,
    exports,
  }
}

function addJsTsDeclaration(decl: any, list: SymbolItem[], code: string, isExport = false) {
  const line = decl.loc?.start.line ?? 0

  if (decl.type === 'FunctionDeclaration' && decl.id) {
    const params = decl.params.map((p: any) => p.name || p.type).join(', ')
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
          const mParams = m.params.map((p: any) => p.name || p.type).join(', ')
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

/** Parses Python source code into classes, functions, and imports */
function parsePython(code: string, filename: string): CodeOutlineResult {
  const lines = code.split('\n')
  const symbols: SymbolItem[] = []
  const imports: string[] = []

  let currentClass: SymbolItem | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!
    const trimmed = rawLine.trim()
    const lineNum = i + 1

    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      imports.push(trimmed)
      continue
    }

    // Class declaration
    const classMatch = rawLine.match(/^class\s+([A-Za-z0-9_]+)(?:\((.*?)\))?:/)
    if (classMatch) {
      currentClass = {
        kind: 'class',
        name: classMatch[1]!,
        line: lineNum,
        signature: `class ${classMatch[1]}${classMatch[2] ? `(${classMatch[2]})` : ''}`,
        children: [],
      }
      symbols.push(currentClass)
      continue
    }

    // Function/method declaration
    const defMatch = rawLine.match(/^(\s*)(async\s+)?def\s+([A-Za-z0-9_]+)\s*\((.*?)\)(?:\s*->\s*(.*?))?:/)
    if (defMatch) {
      const indent = defMatch[1]!.length
      const asyncPrefix = defMatch[2] ? 'async ' : ''
      const name = defMatch[3]!
      const params = defMatch[4]!
      const returnType = defMatch[5] ? ` -> ${defMatch[5]}` : ''
      const sig = `${asyncPrefix}def ${name}(${params})${returnType}`

      const item: SymbolItem = {
        kind: indent > 0 ? 'method' : 'function',
        name,
        line: lineNum,
        signature: sig,
      }

      if (indent > 0 && currentClass) {
        currentClass.children?.push(item)
      } else {
        currentClass = null
        symbols.push(item)
      }
    }
  }

  return {
    filename,
    language: 'python',
    symbols,
    imports,
    exports: [],
  }
}

/** Parses Rust source code into functions, structs, traits, and enums */
function parseRust(code: string, filename: string): CodeOutlineResult {
  const lines = code.split('\n')
  const symbols: SymbolItem[] = []
  const imports: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    const lineNum = i + 1

    if (trimmed.startsWith('use ')) {
      imports.push(trimmed.replace(/;$/, ''))
    } else if (trimmed.match(/^(pub\s+)?(async\s+)?fn\s+([a-zA-Z0-9_]+)/)) {
      const match = trimmed.match(/^(pub(?:\(.*?\))?\s+)?(async\s+)?fn\s+([a-zA-Z0-9_]+)(.*?)(?:\{|;)/)
      if (match) {
        const sig = `${match[1] || ''}${match[2] || ''}fn ${match[3]}${match[4] || ''}`.trim()
        symbols.push({ kind: 'function', name: match[3]!, line: lineNum, signature: sig })
      }
    } else if (trimmed.match(/^(pub\s+)?struct\s+([a-zA-Z0-9_]+)/)) {
      const match = trimmed.match(/^(pub(?:\(.*?\))?\s+)?struct\s+([a-zA-Z0-9_]+)/)
      if (match) {
        symbols.push({ kind: 'struct', name: match[2]!, line: lineNum, signature: `struct ${match[2]}` })
      }
    } else if (trimmed.match(/^(pub\s+)?enum\s+([a-zA-Z0-9_]+)/)) {
      const match = trimmed.match(/^(pub(?:\(.*?\))?\s+)?enum\s+([a-zA-Z0-9_]+)/)
      if (match) {
        symbols.push({ kind: 'enum', name: match[2]!, line: lineNum, signature: `enum ${match[2]}` })
      }
    } else if (trimmed.match(/^(pub\s+)?trait\s+([a-zA-Z0-9_]+)/)) {
      const match = trimmed.match(/^(pub(?:\(.*?\))?\s+)?trait\s+([a-zA-Z0-9_]+)/)
      if (match) {
        symbols.push({ kind: 'trait', name: match[2]!, line: lineNum, signature: `trait ${match[2]}` })
      }
    }
  }

  return {
    filename,
    language: 'rust',
    symbols,
    imports,
    exports: [],
  }
}

/** Parses Go source code into functions, structs, and interfaces */
function parseGo(code: string, filename: string): CodeOutlineResult {
  const lines = code.split('\n')
  const symbols: SymbolItem[] = []
  const imports: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()
    const lineNum = i + 1

    if (trimmed.startsWith('import ') && !trimmed.includes('(')) {
      imports.push(trimmed)
    } else if (trimmed.match(/^func\s+(?:\(.*?\)\s+)?([a-zA-Z0-9_]+)/)) {
      const match = trimmed.match(/^func\s+(?:\((.*?)\)\s+)?([a-zA-Z0-9_]+)(.*?)(?:\{|$)/)
      if (match) {
        const receiver = match[1] ? `(${match[1]}) ` : ''
        const sig = `func ${receiver}${match[2]}${match[3] || ''}`.trim()
        symbols.push({
          kind: match[1] ? 'method' : 'function',
          name: match[2]!,
          line: lineNum,
          signature: sig,
        })
      }
    } else if (trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+struct/)) {
      const match = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+struct/)
      if (match) {
        symbols.push({ kind: 'struct', name: match[1]!, line: lineNum, signature: `type ${match[1]} struct` })
      }
    } else if (trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+interface/)) {
      const match = trimmed.match(/^type\s+([a-zA-Z0-9_]+)\s+interface/)
      if (match) {
        symbols.push({ kind: 'interface', name: match[1]!, line: lineNum, signature: `type ${match[1]} interface` })
      }
    }
  }

  return {
    filename,
    language: 'go',
    symbols,
    imports,
    exports: [],
  }
}

/** Unified entry point for multi-language outline parsing */
export function extractOutline(code: string, filename: string): CodeOutlineResult {
  const lang = detectLanguage(filename)
  switch (lang) {
    case 'typescript':
    case 'typescript-react':
    case 'javascript':
    case 'javascript-react':
      return parseJsTs(code, filename)
    case 'python':
      return parsePython(code, filename)
    case 'rust':
      return parseRust(code, filename)
    case 'go':
      return parseGo(code, filename)
    default:
      return {
        filename,
        language: 'generic',
        symbols: [],
        imports: [],
        exports: [],
      }
  }
}
