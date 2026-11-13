// The retrieval + routing layer, merged into Tool Ultra.
//
// Tool Ultra gives the model a directory and on-demand loading, but the
// model still has to guess the right keywords and spend turns searching. This
// module adds the retrieval layer that makes an unbounded catalog usable:
//
//   tools_find(query)   -> ranked matches (BM25, model-free, always available)
//   tools_route(query)  -> ranked matches, then loads them (the router)
//
// Retrieval is BM25 by default: no model, no network, works offline, and scales
// to a large catalog. When a model is configured (config.model {provider,
// model}), tools_route re-ranks the BM25 candidates with the model, so a
// natural-language intent that shares no words with a tool name still finds it.
// That is the RAG-MCP pattern: retrieve a small candidate set, then rank it.
//
// The BM25 index lives in a Rust sidecar process (sidecar/, tantivy over a Unix
// socket) for headroom: the hot path is native and the TypeScript here is a
// thin client. A dependency-free JS BM25 index is kept as the always-available
// fallback, so retrieval never breaks if the sidecar binary is missing or the
// process dies.
//
// It reuses the core's `toolCatalog` service (passed in by the core's apply),
// so it shares the catalog, the load path, and the token accounting. Without a
// catalog it falls back to the raw tool schemas and its own token estimate;
// tools_route then only retrieves (there is no load path to drive).
//
// Tool definitions are built by hand (no @deepseek-ai/dsh-tools import) so the
// retrieval layer stays self-contained.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closestNames } from '../catalog.js'
import { Bm25 } from './bm25.js'
import { Sidecar } from './sidecar.js'
import type {
  Hit,
  HostContext,
  LlmService,
  Logger,
  RouterConfig,
  SkillRef,
  SkillsService,
  ToolCatalogService,
  ToolDef,
  ToolRef,
} from './types.js'

const pluginDir = dirname(fileURLToPath(import.meta.url))
// This module compiles to lib/router/index.js; the package root is two levels
// up. A published package carries the binary under sidecar/bin/ (filled by
// `npm run build:sidecar`, never committed); a source checkout has a dev build
// under sidecar/target/release/. Prefer the packaged one.
const sidecarBin = [
  join(pluginDir, '..', '..', 'sidecar', 'bin', 'tool-router-sidecar'),
  join(pluginDir, '..', '..', 'sidecar', 'target', 'release', 'tool-router-sidecar'),
].find(existsSync)
// One socket per plugin load: the plugin is loaded once per DSH process, but
// tests load it many times (across processes and within one process), and a
// shared fixed path would make them fight over the same socket. The PID plus a
// per-load sequence keeps every instance on its own socket.
let sidecarSocketSeq = 0
function sidecarSocketPath(): string {
  sidecarSocketSeq += 1
  return join(pluginDir, '..', '..', `.sidecar-${process.pid}-${sidecarSocketSeq}.sock`)
}

// --- helpers -----------------------------------------------------------------

function estimateTokens(schema: unknown): number {
  const text = JSON.stringify(schema)
  let wide = 0
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e7f) wide += 1
  return Math.ceil((text.length - wide) / 4 + wide)
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`
}

function firstLine(text: string | undefined, max = 80): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const first = flat.split(/(?<=[.!?。！？])\s/)[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

function toolText(t: ToolRef): string {
  return `${t.name} ${t.summary} ${t.description} ${t.group} ${t.category}`
}

function skillText(s: SkillRef): string {
  return `${s.name} ${s.summary} ${s.whenToUse ?? ''}`
}

function formatFind(hits: Hit<ToolRef>[], query?: string, catalog?: ToolCatalogService): string {
  if (!hits.length) {
    // A single-word query that names no tool may be a misspelling of one.
    let hint = ''
    if (query && catalog) {
      try {
        const suggestions = closestNames(catalog.get(), query)
        if (suggestions.length) hint = ` Did you mean: ${suggestions.join(', ')}?`
      } catch {
        // a hint must never break the search
      }
    }
    return `No tools matched. Try different words, or tools_ls("/") to browse the directory.${hint}`
  }
  const lines = hits.map((h, i) => {
    const t = h.ref
    const risk = t.highRisk ? ' [high risk]' : ''
    return `${i + 1}. ${t.name}\n   ${t.path} · ${fmtTokens(t.tokens)}${risk}\n   ${t.summary}`
  })
  return `Best matches (load with tools_route, or tools_load by path):\n${lines.join('\n')}`
}

function formatSkillFind(hits: Hit<SkillRef>[]): string {
  if (!hits.length) return 'No skills matched. Try different words.'
  const lines = hits.map((h, i) => {
    const s = h.ref
    const extra = s.whenToUse ? ` — ${s.whenToUse}` : ''
    return `${i + 1}. ${s.name}\n   ${s.summary}${extra}`
  })
  return `Best matching skills (load one with skills_route):\n${lines.join('\n')}`
}

/** Build a tool definition by hand (no @deepseek-ai/dsh-tools dependency). */
function makeTool(tool: Omit<ToolDef, 'output'>): ToolDef {
  return {
    ...tool,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
  }
}

/**
 * Register the retrieval + routing tools (tools_find, tools_route, skills_find,
 * skills_route) on the host. Called by the core's apply() after it provides the
 * toolCatalog service, so the router reuses the catalog, the load path, and the
 * token accounting.
 */
export function registerRouter(ctx: HostContext, config: RouterConfig = {}, catalog?: ToolCatalogService): void {
  const logger: Logger = (typeof ctx.logger === 'function' ? ctx.logger('tool-router') : ctx.logger) ?? console
  const cat = (catalog ?? ctx.toolCatalog ?? (typeof ctx.get === 'function' ? ctx.get('toolCatalog') : undefined)) as ToolCatalogService | undefined
  const bm25 = new Bm25<ToolRef>({ k1: config.k1, b: config.b })
  const skillBm25 = new Bm25<SkillRef>({ k1: config.k1, b: config.b })
  const topK = config.topK ?? 8
  const maxBudget = config.maxBudget ?? 20000
  const model = config.model ?? {}
  const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) as LlmService | undefined
  const sidecar = new Sidecar({
    bin: config.sidecar?.bin ?? sidecarBin ?? join(pluginDir, '..', '..', 'sidecar', 'bin', 'tool-router-sidecar'),
    socket: config.sidecar?.socket ?? sidecarSocketPath(),
    timeoutMs: config.sidecar?.timeoutMs,
    logger,
  })

  // Refs aligned to index doc ids (the sidecar returns doc ids; we map them
  // back to these refs). Kept in sync with the JS BM25 fallback.
  let toolRefs: ToolRef[] = []
  let skillRefs: SkillRef[] = []

  /** The default working directory, used to scope the skill catalog view. */
  function cwdOf(): string | undefined {
    try {
      const wd = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      return (wd as { defaultDirectory?: string } | undefined)?.defaultDirectory
    } catch {
      return undefined
    }
  }

  /** Rebuild the tool index (JS fallback + sidecar) from the catalog. */
  function rebuild(): void {
    let tools: ToolRef[]
    if (cat && typeof cat.get === 'function') {
      const c = cat.get()
      tools = [...c.tools.values()].map((t) => ({
        name: t.name,
        path: `/${t.category}/${t.group}/${t.short}`,
        summary: t.summary,
        description: t.description,
        group: t.group,
        category: t.category,
        tokens: t.tokens,
        highRisk: t.highRisk === true,
      }))
    } else {
      tools = ctx.tools.schemas().map((s) => ({
        name: s.name,
        path: s.name,
        summary: firstLine(s.description),
        description: s.description ?? '',
        group: '',
        category: '',
        tokens: estimateTokens(s),
        highRisk: false,
      }))
    }
    toolRefs = tools
    bm25.build(tools.map((t) => ({ ref: t, text: toolText(t) })))
    void sidecar.index('tools', tools.map((t) => ({ ref: t, text: toolText(t) })))
  }
  rebuild()

  if (cat) {
    ctx.effect(() => ctx.on('tool-catalog/after-rebuild', () => rebuild()), 'tool-router.rebuild()')
  }

  // Tools register after this plugin's apply() runs (plugin load order), so the
  // catalog is often empty on the first rebuild. Rebuild again, debounced, when
  // the tool set changes so the index catches up without rebuilding per tool.
  let rebuildTimer: NodeJS.Timeout | null = null
  function scheduleRebuild(): void {
    if (rebuildTimer) return
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      rebuild()
    }, 200)
    rebuildTimer.unref?.()
  }
  try {
    ctx.effect(() => ctx.on('tools/change', () => { scheduleRebuild() }), 'tool-router.tools-change()')
  } catch (caught) {
    logger?.warn?.(`tool-router: tools/change hook skipped: ${caught instanceof Error ? caught.message : String(caught)}`)
  }

  /**
   * Rebuild the skill index from the skill registry. Skills have the same
   * progressive-disclosure shape as tools: a cheap summary (name + description)
   * here, the full body loaded on demand by skills_route.
   */
  async function rebuildSkills(): Promise<void> {
    // The skill registry is the cordis `skills` service, looked up via ctx.get
    // (ctx.skills throws when the service is not injected into this plugin).
    // list() takes {cwd, scope}; scope is left undefined for the global layer.
    try {
      const skillsApi = (typeof ctx.get === 'function' ? ctx.get('skills') : undefined) as SkillsService | undefined
      if (!skillsApi || typeof skillsApi.list !== 'function') return
      const cwd = cwdOf()
      const skills = await skillsApi.list({ cwd })
      const refs: SkillRef[] = skills
        .filter((s) => s.invocation?.modelInvocable !== false)
        .map((s) => ({
          name: s.name,
          summary: s.description ?? '',
          whenToUse: s.whenToUse ?? '',
          source: s.source,
          provider: s.provider,
        }))
      skillRefs = refs
      skillBm25.build(refs.map((s) => ({ ref: s, text: skillText(s) })))
      void sidecar.index('skills', refs.map((s) => ({ ref: s, text: skillText(s) })))
    } catch (caught) {
      logger?.warn?.(`tool-router: skill index rebuild failed: ${caught instanceof Error ? caught.message : String(caught)}`)
    }
  }

  // Start the sidecar, then rebuild the indexes. The initial rebuild() and
  // rebuildSkills() runs fire before the sidecar is ready (and the catalog may
  // still be empty at apply() time); rebuilding after start() re-reads the
  // catalog and pushes a fresh index now that the sidecar is up.
  void (async () => {
    const ok = await sidecar.start()
    if (!ok) return
    rebuild()
    void rebuildSkills()
  })()

  void rebuildSkills()
  try {
    ctx.effect(() => ctx.on('skills/change', () => { void rebuildSkills() }), 'tool-router.skills-rebuild()')
  } catch (caught) {
    logger?.warn?.(`tool-router: skills change hook skipped: ${caught instanceof Error ? caught.message : String(caught)}`)
  }

  // Kill the sidecar child and clear the pending rebuild on disposal.
  ctx.effect(() => () => {
    if (rebuildTimer) clearTimeout(rebuildTimer)
    sidecar.stop()
  }, 'tool-router.sidecar-stop()')

  /** Search the tool index: sidecar first, JS BM25 fallback. */
  async function searchTools(query: string, limit: number): Promise<Hit<ToolRef>[]> {
    const hits = await sidecar.search('tools', query, limit)
    if (hits) return hits.map((h) => ({ ref: toolRefs[h.id], score: h.score }))
    return bm25.search(query, limit)
  }

  /** Search the skill index: sidecar first, JS BM25 fallback. */
  async function searchSkills(query: string, limit: number): Promise<Hit<SkillRef>[]> {
    const hits = await sidecar.search('skills', query, limit)
    if (hits) return hits.map((h) => ({ ref: skillRefs[h.id], score: h.score }))
    return skillBm25.search(query, limit)
  }

  /**
   * Optional model re-rank of the BM25 candidates. Returns the top-k refs.
   * Any failure falls back to the BM25 order, so the router never breaks on a
   * model hiccup.
   */
  async function rerank<T extends { name: string; summary: string }>(query: string, candidates: Hit<T>[], k: number): Promise<Hit<T>[]> {
    if (!llm || !model.provider || !model.model || candidates.length <= k) return candidates.slice(0, k)
    const list = candidates.map((c, i) => `${i + 1}. ${c.ref.name}: ${c.ref.summary}`).join('\n')
    const prompt = [
      'You are a tool router. Pick the tools that best fit the task.',
      '',
      `Task: ${query}`,
      '',
      'Candidates:',
      list,
      '',
      `Return the numbers of the best tools, comma-separated, at most ${k}. If none fit, return "none".`,
    ].join('\n')
    try {
      let text = ''
      let finished = false
      const options = {
        provider: model.provider,
        model: model.model,
        system: 'You are a strict tool router. You answer with numbers only.',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: config.maxTokens ?? 24,
        temperature: 0,
      }
      for await (const chunk of llm.stream(options)) {
        if (finished) break
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
        else if (chunk.type === 'finish') finished = true
      }
      const picks = String(text).split(/[,\s]+/).map((s) => Number.parseInt(s, 10)).filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length)
      const unique = [...new Set(picks)].slice(0, k).map((n) => candidates[n - 1])
      return unique.length ? unique : candidates.slice(0, k)
    } catch (caught) {
      logger?.warn?.(`tool-router: re-rank failed, using BM25 order: ${caught instanceof Error ? caught.message : String(caught)}`)
      return candidates.slice(0, k)
    }
  }

  function budgetReport(agent: unknown): string {
    if (!cat || typeof cat.wireTokens !== 'function') return ''
    const tokens = cat.wireTokens(agent)
    const pct = Math.round((tokens / maxBudget) * 100)
    return `Context budget: ${tokens} tokens of loaded tool schemas (${pct}% of the ${maxBudget} budget)${tokens > maxBudget ? ' — OVER budget; unload tools you no longer need' : ''}`
  }

  // --- tools_find --------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'tools_find',
    description:
      'Search the whole tool catalog by intent. Describe what you want to do in plain words (e.g. "send an email", "search the web", "read a PDF"); it returns the best-matching tools ranked by relevance, each with its path, one-line summary, and schema size. Use this before loading when you are not sure which tool fits. It retrieves only; it does not load anything.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in plain words.' },
        limit: { type: 'number', description: `How many matches to return (default ${topK}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return formatFind(await searchTools(String(args.query), Number(args.limit ?? topK)), String(args.query), cat)
    },
  }))

  // --- tools_route -------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'tools_route',
    description:
      'Find the tools that fit a task and load them in one step. Describe the task in plain words; it retrieves the best matches, re-ranks them with the model when one is configured, and loads them so they are callable from your next step. Use this to get set up for a task without browsing the directory. Pass load=false to only retrieve, without loading.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task, in plain words.' },
        limit: { type: 'number', description: `How many tools to load (default ${topK}).` },
        load: { type: 'boolean', description: 'Load the matches (default true). Set false to only retrieve.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const want = Number(args.limit ?? topK)
      const candidates = await searchTools(String(args.query), Math.max(want, 10))
      const ranked = await rerank(String(args.query), candidates, want)
      if (args.load === false || !cat) return formatFind(ranked as Hit<ToolRef>[], String(args.query), cat)
      if (!agent) return formatFind(ranked as Hit<ToolRef>[], String(args.query), cat)
      const targets = (ranked as Hit<ToolRef>[]).map((h) => h.ref.name)
      const loaded = await cat.load(agent, targets)
      const result = typeof loaded === 'string' ? loaded : loaded.message
      const budget = budgetReport(agent)
      return budget ? `${result}\n${budget}` : result
    },
  }))

  // --- skills_find -------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'skills_find',
    description:
      'Search the whole skill catalog by intent. Describe the kind of task you are doing (e.g. "write a pull request", "develop a DSH plugin", "add a badge"); it returns the best-matching skills ranked by relevance, each with its name and one-line description. Use this before loading when you are not sure which skill fits. It retrieves only; it does not load anything.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The kind of task you are doing, in plain words.' },
        limit: { type: 'number', description: `How many matches to return (default ${topK}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return formatSkillFind(await searchSkills(String(args.query), Number(args.limit ?? topK)))
    },
  }))

  // --- skills_route ------------------------------------------------------------
  ctx.tools.register(makeTool({
    name: 'skills_route',
    description:
      'Find the best skill for a task and load its full instructions in one step. Describe the task in plain words; it retrieves the best matches, re-ranks them with the model when one is configured, and returns the top skill\'s complete body so you can act on it immediately. Use this to get the right instructions without browsing the skill catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task, in plain words.' },
        limit: { type: 'number', description: `How many candidates to consider (default ${topK}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args) {
      const want = Number(args.limit ?? topK)
      const candidates = await searchSkills(String(args.query), Math.max(want, 5))
      if (!candidates.length) return 'No skills matched. Try different words.'
      const ranked = await rerank(String(args.query), candidates, want)
      const top = ranked[0]
      let body = ''
      try {
        const skillsApi = (typeof ctx.get === 'function' ? ctx.get('skills') : undefined) as SkillsService | undefined
        const def = skillsApi ? await skillsApi.get(top.ref.name, { cwd: cwdOf() }) : undefined
        if (def?.content) body = def.content
      } catch {
        // fall through to the summary
      }
      const others = ranked.slice(1).map((r) => r.ref.name)
      const header = `Loaded skill "${top.ref.name}"${top.ref.source ? ` (source: ${top.ref.source})` : ''}:`
      const rest = body ? `\n\n${body}` : `\n\n${top.ref.summary}${top.ref.whenToUse ? ` — ${top.ref.whenToUse}` : ''}`
      return others.length ? `${header}${rest}\n\nOther candidates: ${others.join(', ')}` : `${header}${rest}`
    },
  }))

  if (!cat) logger?.info?.('tool-router: no toolCatalog service; tools_route retrieves only')
}