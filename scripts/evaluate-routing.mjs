// Offline selection probe. Reads metadata only; never runs a selected tool or calls a model.
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { registerRouter } from '../packages/dsh-tool-ultra-core/lib/router/index.js'

export async function evaluateRouting(tools, cases, limit = 3) {
  if (!Array.isArray(tools) || !tools.length || !Array.isArray(cases) || !cases.length) throw Error('Provide non-empty tools and cases arrays')
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('limit must be an integer from 1 to 50')
  const catalog = new Map()
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || !tool.name || catalog.has(tool.name)) throw Error('Tool names must be non-empty and unique')
    if (!Number.isFinite(tool.tokens) || tool.tokens < 0) throw Error(`Missing schema token estimate: ${tool.name}`)
    catalog.set(tool.name, { ...tool, short: tool.short ?? tool.name, group: tool.group ?? 'fixture',
      category: tool.category ?? 'uncategorized', summary: tool.summary ?? tool.description ?? '', description: tool.description ?? '' })
  }
  const definitions = new Map(), disposers = []
  let trace
  registerRouter({ tools: { schemas: () => [], register: tool => definitions.set(tool.name, tool) },
    effect: fn => { const dispose = fn(); if (dispose) disposers.push(dispose) }, on: () => () => {},
    emit: (name, value) => { if (name === 'tool-catalog/route') trace = value.route },
    logger: { info() {}, warn() {} },
  }, { sidecar: { bin: '/unavailable/offline-selection-probe' } }, { get: () => ({ tools: catalog }),
    load: async () => { throw Error('Probe must not load tools') } })
  try {
    const rows = []
    const ids = new Set()
    for (const item of cases) {
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.query !== 'string' || !Array.isArray(item.expected)) throw Error('Cases need unique ids, queries and expected arrays')
      ids.add(item.id)
      const expected = [...new Set(item.expected)]
      for (const name of expected) if (!catalog.has(name)) throw Error(`${item.id}: expected tool is absent: ${name}`)
      trace = undefined
      await definitions.get('tools_route').execute({ query: item.query, limit, load: false })
      if (!trace) throw Error('Router did not expose a selection trace')
      const selected = trace.selected
      rows.push({ id: item.id, selected, expected,
        recall: expected.length ? expected.filter(name => selected.includes(name)).length / expected.length : null,
        correctAbstention: expected.length ? null : selected.length === 0,
        selectedSchemaTokensEstimated: selected.reduce((sum, name) => sum + catalog.get(name).tokens, 0),
        retrievalMs: trace.durationMs })
    }
    const positives = rows.filter(row => row.recall !== null)
    return { kind: 'offline-tool-selection', modelCalls: 0, toolExecutions: 0, limit, catalogSize: catalog.size,
      allSchemasTokensEstimated: [...catalog.values()].reduce((sum, tool) => sum + tool.tokens, 0),
      meanExpectedRecallAtK: positives.length ? positives.reduce((sum, row) => sum + row.recall, 0) / positives.length : null,
      meanSelectedSchemaTokensEstimated: rows.reduce((sum, row) => sum + row.selectedSchemaTokensEstimated, 0) / rows.length,
      limitations: ['Schema estimates exclude router/pinned tools, discovery turns, history, results and prompt caching.',
        'Selection recall is not task success, provider token usage, money saved or an end-to-end comparison.'], rows }
  } finally { for (const dispose of disposers.reverse()) dispose() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, cases: { type: 'string' }, limit: { type: 'string', default: '3' } } })
  if (!values.catalog || !values.cases) throw Error('Usage: node scripts/evaluate-routing.mjs --catalog catalog.json --cases cases.json [--limit 3]')
  const catalog = JSON.parse(await readFile(values.catalog, 'utf8'))
  const cases = JSON.parse(await readFile(values.cases, 'utf8'))
  console.log(JSON.stringify(await evaluateRouting(Array.isArray(catalog) ? catalog : catalog.tools, cases, Number(values.limit)), null, 2))
}
