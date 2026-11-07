// Code Insight pack unit tests: AST outline extraction, symbol searching, call graphs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTools,
  apply,
  TOOL_NAMES,
  extractOutline,
  detectLanguage,
} from '../../packages/dsh-tool-ultra-pack-code-insight/lib/index.js'

test('code-insight: every tool is declared in package.json toolCatalog', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-code-insight/package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dsh.toolCatalog.tools).sort(), [...TOOL_NAMES].sort())
  assert.deepEqual(createTools().map((t) => t.name).sort(), [...TOOL_NAMES].sort())
})

test('code-insight: apply registers tools minus disabled ones', () => {
  const registered = []
  apply({ tools: { register: (d) => registered.push(d.name ?? d.schema?.name) } }, { disable: ['code_callgraph'] })
  assert.equal(registered.length, TOOL_NAMES.length - 1)
  assert.ok(!registered.includes('code_callgraph'))
})

test('code-insight: TypeScript AST outline extraction', async () => {
  const tsCode = `
import { Config, State } from './config.js';
import express from 'express';

export interface UserProfile {
  id: string;
  name: string;
}

export type Role = 'admin' | 'guest';

export class UserManager extends BaseService {
  private users: Map<string, UserProfile> = new Map();

  async findUser(id: string): Promise<UserProfile | null> {
    return this.users.get(id) || null;
  }
}

export async function bootstrap(port: number) {
  console.log("listening on", port);
}
`
  const outline = extractOutline(tsCode, 'service.ts')
  assert.equal(outline.language, 'typescript')
  assert.equal(outline.imports.length, 2)
  assert.ok(outline.imports.some((i) => i.includes('UserProfile') || i.includes('config.js')))
  assert.ok(outline.exports.includes('UserProfile'))
  assert.ok(outline.exports.includes('UserManager'))
  assert.ok(outline.exports.includes('bootstrap'))

  const classSym = outline.symbols.find((s) => s.name === 'UserManager')
  assert.ok(classSym)
  assert.equal(classSym.kind, 'class')
  assert.equal(classSym.children?.length, 1)
  assert.equal(classSym.children[0].name, 'findUser')
})

test('code-insight: Python outline extraction', async () => {
  const pyCode = `
import os
from pathlib import Path

class DatabaseConnection:
    def __init__(self, dsn: str):
        self.dsn = dsn

    async def execute_query(self, sql: str) -> list:
        pass

def calculate_metric(x: int, y: int) -> float:
    return float(x + y)
`
  const outline = extractOutline(pyCode, 'db.py')
  assert.equal(outline.language, 'python')
  assert.equal(outline.imports.length, 2)

  const classSym = outline.symbols.find((s) => s.name === 'DatabaseConnection')
  assert.ok(classSym)
  assert.equal(classSym.children?.length, 2)
  assert.equal(classSym.children[0].name, '__init__')
  assert.equal(classSym.children[1].name, 'execute_query')

  const funcSym = outline.symbols.find((s) => s.name === 'calculate_metric')
  assert.ok(funcSym)
  assert.equal(funcSym.kind, 'function')
})

test('code-insight: code_symbols search and code_callgraph tools', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'code-test-'))
  try {
    const mainFile = join(temp, 'main.ts')
    const utilFile = join(temp, 'utils.ts')

    await writeFile(
      mainFile,
      `
import { helperFunction, HelperClass } from './utils.js';
export function startApp() {
  helperFunction();
}
`,
    )

    await writeFile(
      utilFile,
      `
export function helperFunction() { return 42; }
export class HelperClass {}
`,
    )

    const tools = createTools()
    const outlineTool = tools.find((t) => t.name === 'code_outline')
    const symbolsTool = tools.find((t) => t.name === 'code_symbols')
    const callgraphTool = tools.find((t) => t.name === 'code_callgraph')

    // 1. code_outline output check
    const outlineText = await outlineTool.execute({ path: mainFile })
    assert.match(outlineText, /Outline: .*main\.ts \(typescript\)/)
    assert.match(outlineText, /startApp/)

    // 2. code_symbols search with query
    const symbolsText = await symbolsTool.execute({ path: temp, query: 'helper' })
    assert.match(symbolsText, /helperFunction/)
    assert.match(symbolsText, /HelperClass/)

    // 3. code_callgraph check
    const graphText = await callgraphTool.execute({ path: temp })
    assert.match(graphText, /Dependency Graph/)
    assert.match(graphText, /utils\.js/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
