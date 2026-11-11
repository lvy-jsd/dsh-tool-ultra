// dsh-tool-ultra-classifier-llm: place groups with a small model, cached.
//
// The directory has to be stable: a category that changes between sessions
// invalidates paths the model memorised and costs another cache miss. So this
// classifier never classifies on the hot path.
//
//   - `categorize(group)` is synchronous and answers from a cache file;
//   - a miss is queued and the group stays `uncategorized` until an answer
//     lands (the plugin then calls `toolCatalog.refresh()`);
//   - answers are cached by a hash of the group name, its tool names and their
//     descriptions, so re-classification happens only when a group really
//     changed.
//
// The cache is per group, not per call, and the whole group is classified at
// once: a host with 40 groups makes ~40 small requests in total, not per turn.
//
// Model selection follows the project convention: `model: { provider, model }`.
// With no model configured, the classifier does nothing and every group stays
// `uncategorized` — the plugin is optional, and so is the model.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Classifier, ExtensionContext, FoundTool, HostContext, Logger, SearchFallback } from '@lvy-jsd/dsh-tool-ultra-core'

/** What the classifier needs of a group (a catalog Group or a GroupProbe both fit). */
export interface GroupInput {
  name: string
  tools?: { name: string, description?: string }[]
}

/** Group cache key -> category. */
export type CategoryCache = Record<string, string>

/** Returns a category name (anything else counts as no answer) or throws. */
export type ClassifyGroup = (group: GroupInput) => Promise<string | undefined> | string | undefined

export interface LlmClassifierOptions {
  name?: string
  priority?: number
  cache?: CategoryCache
  classifyGroup?: ClassifyGroup
  onBatch?(cache: CategoryCache): unknown
  batchSize?: number
  logger?: Logger
  maxPending?: number
}

export interface LlmClassifier extends Classifier {
  name: string
  priority: number
  categorize(group: GroupInput): string | undefined
  schedule(): Promise<void>
  drain(): Promise<void>
  pending(): number
  failedKeys(): string[]
}

export interface ClassifierLlmConfig {
  enabled?: boolean
  name?: string
  priority?: number
  cacheFile?: string
  /** A cache object to use instead of reading cacheFile. */
  cache?: CategoryCache
  model?: { provider?: string, model?: string }
  maxTokens?: number
  batchSize?: number
  /** Replaces the model call (tests, custom pipelines). */
  classify?: ClassifyGroup
  /**
   * Match a plain-language request to a tool when the keyword search found
   * little. On by default when a model is configured; off without one.
   */
  retrieval?: boolean
  /** Replaces the retrieval model call (tests, custom pipelines). */
  pickTools?: PickTools
  /** How many tools the model may name for one request. */
  maxRetrievalTools?: number
  /** How many tools the model sees. */
  maxRetrievalCandidates?: number
}

export const name = 'tool-manager-classifier-llm'
export const inject = ['toolCatalog']

/** Ordinary tier: below user overrides and plugin declarations, above nothing. */
export const DEFAULT_PRIORITY = 50

/** Categories the model may choose from, mirroring the core vocabulary. */
export const CATEGORIES = [
  'device', 'code', 'media', 'maps', 'browser', 'memory',
  'collaboration', 'automation', 'connectors', 'search', 'system',
]

export function defaultCacheFile(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.config', 'deepseek-harness')
  return join(dshHome, 'tool-manager', 'classifier-cache.json')
}

/**
 * Cache key for one group. Tool names are sorted so ordering never matters, and
 * each description is hashed so a rewritten description re-classifies while an
 * unrelated tool joining the group does not re-hash the rest.
 */
export function groupKey(group: GroupInput): string {
  const parts = [...(group.tools ?? [])]
    .map((tool) => `${tool.name}:${createHash('sha1').update(String(tool.description ?? '')).digest('hex').slice(0, 12)}`)
    .sort()
  return createHash('sha1').update(`${group.name}\n${parts.join('\n')}`).digest('hex').slice(0, 16)
}

/** Read the cache; a corrupt or missing file is an empty cache, never a crash. */
export function readCache(file: string, logger?: Logger): CategoryCache {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException
    if (error.code !== 'ENOENT') logger?.warn?.(`classifier-llm: ignoring unreadable cache ${file}: ${error.message}`)
    return {}
  }
}

/** Write the cache atomically, so a crash cannot leave a half-written file. */
export function writeCache(file: string, cache: CategoryCache, logger?: Logger): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(cache, null, 2))
    renameSync(tmp, file)
  } catch (caught) {
    const error = caught as Error
    logger?.warn?.(`classifier-llm: writing cache ${file} failed: ${error.message}`)
  }
}

/** Prompt for one group: the tool list plus the fixed category vocabulary. */
export function buildPrompt(group: GroupInput): string {
  const tools = (group.tools ?? []).map((tool) => {
    const first = String(tool.description ?? '').split('\n')[0].trim().slice(0, 160)
    return `- ${tool.name}: ${first}`
  })
  return [
    'You place one group of tools from a coding agent into a single category.',
    '',
    `Group name: ${group.name}`,
    'Tools:',
    ...tools,
    '',
    `Answer with exactly one of these category names and nothing else: ${CATEGORIES.join(', ')}.`,
  ].join('\n')
}

/** Answer with the single named category, or undefined if absent or ambiguous. */
export function parseCategory(text: unknown): string | undefined {
  const value = String(text ?? '').toLowerCase()
  const found: string[] = []
  for (const category of CATEGORIES) {
    if (new RegExp(`(^|[^a-z])${category}([^a-z]|$)`).test(value)) found.push(category)
  }
  return found.length === 1 ? found[0] : undefined
}

/**
 * Build the classifier. `classifyGroup(group)` returns a category name or
 * throws; the pump calls it off the hot path and caches whatever it returns.
 */
export function createLlmClassifier({
  name: classifierName = 'llm:groups',
  priority = DEFAULT_PRIORITY,
  cache = {},
  classifyGroup,
  onBatch,
  batchSize = 5,
  logger,
  maxPending = 200,
}: LlmClassifierOptions = {}): LlmClassifier {
  const pending = new Map<string, GroupInput>()      // key -> group
  const inFlight = new Set<string>()     // keys being classified right now
  const failed = new Set<string>()       // keys that errored; not retried this process
  let pumping = false

  function categorize(group: GroupInput): string | undefined {
    const key = groupKey(group)
    const cached = cache[key]
    if (typeof cached === 'string') return cached
    // Without a way to classify, queueing would only grow forever.
    if (typeof classifyGroup !== 'function') return undefined
    if (!failed.has(key) && !inFlight.has(key) && pending.size < maxPending) pending.set(key, group)
    return undefined
  }

  async function pump(): Promise<void> {
    if (pumping || typeof classifyGroup !== 'function') return
    pumping = true
    try {
      while (pending.size > 0) {
        const batch = [...pending.entries()].slice(0, batchSize)
        // Reserve the entire batch before yielding to the first model request.
        // A catalog refresh must not queue a later member of this batch again.
        for (const [key] of batch) {
          pending.delete(key)
          inFlight.add(key)
        }
        let changed = false
        for (const [key, group] of batch) {
          try {
            const category = await classifyGroup!(group)
            if (typeof category === 'string' && CATEGORIES.includes(category)) {
              cache[key] = category
              changed = true
            } else {
              // An unusable answer is remembered as a failure so the group is
              // not re-asked on every rebuild.
              failed.add(key)
              logger?.warn?.(`classifier-llm: no usable category for group "${group.name}"`)
            }
          } catch (caught) {
            const error = caught as Error
            failed.add(key)
            logger?.warn?.(`classifier-llm: classifying "${group.name}" failed: ${error.message}`)
          } finally {
            inFlight.delete(key)
          }
        }
        if (changed) await onBatch?.(cache)
      }
    } finally {
      pumping = false
    }
  }

  /** Start the background pump; call it after any categorize() miss. */
  function schedule(): Promise<void> {
    if (pending.size === 0 || typeof classifyGroup !== 'function') return Promise.resolve()
    return pump()
  }

  return {
    name: classifierName,
    priority,
    categorize,
    schedule,
    /** Wait for the current queue to drain (tests). */
    async drain() {
      if (typeof classifyGroup !== 'function') {
        pending.clear()
        return
      }
      while (pending.size > 0 || pumping) await pump()
    },
    pending: () => pending.size,
    failedKeys: () => [...failed],
  }
}

/**
 * One small-model call: fixed system prompt, answer read as plain text.
 *
 * The stream protocol is consumed directly instead of through the host's
 * assembler, so this package needs no import from the harness — the `llm`
 * service is enough, and a deployment without it simply stays uncategorized.
 */
export function createLlmCaller(llm: Pick<LlmRuntime, 'stream'>, { provider, model, maxTokens = 16, temperature = 0 }: { provider: string, model: string, maxTokens?: number, temperature?: number }): ClassifyGroup {
  return async function classifyGroup(group: GroupInput): Promise<string | undefined> {
    let text = ''
    let finished = false
    const options: GenerateOptions = {
      provider,
      model,
      system: 'You are a strict classifier. You answer with one word.',
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(group) }] }],
      maxTokens,
      temperature,
    }
    for await (const chunk of llm.stream(options)) {
      if (finished) throw new Error('the model emitted data after its finish')
      // The stream protocol carries text as deltas; block-end is ignored so a
      // provider that emits both does not double the text.
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'finish') {
        finished = true
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          const { code, message } = chunk.reason.failure
          throw new Error(`${chunk.reason.kind} ${code}: ${message}`)
        }
        if (chunk.reason.kind !== 'stop') throw new Error(`ended with ${chunk.reason.kind}`)
      }
    }
    if (!finished) throw new Error('the model emitted no finish chunk')
    return parseCategory(text.trim())
  }
}

// --- retrieval: matching a plain-language request to a tool --------------------
//
// The keyword search finds a tool when the request uses the words in its
// schema. A person rarely does ("what did I write about taxes" vs "search
// personal notes by keyword"), so the last step is a small model that reads
// the request and the tool list and names the tools that fit.
//
// It runs only when the keyword search was weak, so a clear request never
// reaches a model, and a request that matched never pays for this one.

/** One tool as the model sees it: a name and one line of what it does. */
export interface RetrievalCandidate {
  name: string
  summary: string
}

/** The model answers with the names of the tools that fit. */
export type PickTools = (intent: string, candidates: RetrievalCandidate[]) => Promise<string[] | undefined> | string[] | undefined

export interface RetrievalOptions {
  /** The model call. Injected in tests; the real one needs a configured model. */
  pickTools?: PickTools
  /** Every tool that could match, as the model sees it. */
  candidates?: () => RetrievalCandidate[]
  /** Where a named tool is looked up. */
  lookup?: (name: string) => FoundTool | undefined
  logger?: Logger
  /** Answers per request, so the same question is not paid for twice. */
  cache?: Map<string, FoundTool[]>
  /** How many tools the model may name. */
  maxTools?: number
  /** How many candidates the model sees. */
  maxCandidates?: number
}

/** The prompt: the request, then the tool list, then the answer format. */
export function buildRetrievalPrompt(intent: string, candidates: RetrievalCandidate[]): string {
  const lines = candidates.map((tool) => `- ${tool.name}: ${String(tool.summary ?? '').split('\n')[0].trim().slice(0, 120)}`)
  return [
    'You match a request to the tools of a coding agent.',
    '',
    `Request: ${intent}`,
    '',
    'Tools:',
    ...lines,
    '',
    'Answer with the names of the tools that best match the request, comma separated, at most three.',
    'If no tool fits, answer with none.',
  ].join('\n')
}

/**
 * Read the model's answer: known tool names only, in the order it named them.
 * Anything else is dropped, so a chatty model cannot smuggle in a tool that
 * does not exist.
 */
export function parseToolNames(text: unknown, known: Iterable<string>, max = 3): string[] {
  const names = new Map([...known].map((name) => [name.toLowerCase(), name]))
  const found: string[] = []
  for (const part of String(text ?? '').split(/[\s,;]+/)) {
    const name = names.get(part.trim().toLowerCase().replace(/[.:;]+$/, ''))
    if (name && !found.includes(name)) found.push(name)
    if (found.length >= max) break
  }
  return found
}

/** Build the fallback the core's search calls when the keyword match was weak. */
export function createSearchFallback({
  pickTools,
  candidates,
  lookup,
  logger,
  cache = new Map<string, FoundTool[]>(),
  maxTools = 3,
  maxCandidates = 120,
}: RetrievalOptions = {}): SearchFallback {
  const limit = cache.size > 50 ? 50 : cache.size
  return async function fallback(query: string, _hits: FoundTool[]): Promise<FoundTool[] | undefined> {
    if (typeof pickTools !== 'function' || typeof candidates !== 'function') return undefined
    const key = query.trim().toLowerCase()
    if (!key) return undefined
    const cached = cache.get(key)
    if (cached) return cached
    const list = candidates().slice(0, maxCandidates)
    if (!list.length) return undefined
    let names: string[] | undefined
    try {
      names = await pickTools(query, list)
    } catch (error) {
      logger?.warn?.(`classifier-llm: picking tools for "${query}" failed: ${(error as Error).message}`)
      return undefined
    }
    const picked = parseToolNames((names ?? []).join(', '), list.map((c) => c.name), maxTools)
    const found: FoundTool[] = []
    for (const name of picked) {
      const tool = lookup?.(name)
      if (tool && !found.some((t) => t.name === tool.name)) found.push(tool)
    }
    if (cache.size >= limit) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, found)
    return found
  }
}

/**
 * One small-model call for retrieval: the request and the tool list go in,
 * the names of the matching tools come out.
 */
export function createToolPicker(llm: Pick<LlmRuntime, 'stream'>, { provider, model, maxTokens = 48, temperature = 0 }: { provider: string, model: string, maxTokens?: number, temperature?: number }): PickTools {
  return async function pickTools(intent: string, candidates: RetrievalCandidate[]): Promise<string[] | undefined> {
    let text = ''
    let finished = false
    const options: GenerateOptions = {
      provider,
      model,
      system: 'You are a strict tool matcher. You answer with tool names, comma separated.',
      messages: [{ role: 'user', content: [{ type: 'text', text: buildRetrievalPrompt(intent, candidates) }] }],
      maxTokens,
      temperature,
    }
    for await (const chunk of llm.stream(options)) {
      if (finished) throw new Error('the model emitted data after its finish')
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'finish') {
        finished = true
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          const { code, message } = chunk.reason.failure
          throw new Error(`${chunk.reason.kind} ${code}: ${message}`)
        }
        if (chunk.reason.kind !== 'stop') throw new Error(`ended with ${chunk.reason.kind}`)
      }
    }
    if (!finished) throw new Error('the model emitted no finish chunk')
    return parseToolNames(text.trim(), candidates.map((c) => c.name))
  }
}

export function apply(ctx: ExtensionContext & Pick<HostContext, 'get'> & { llm?: Pick<LlmRuntime, 'stream'> }, config: ClassifierLlmConfig = {}) {
  const logger = (typeof ctx.logger === 'function' ? ctx.logger('tool-manager-classifier-llm') : ctx.logger) ?? console
  if (config.enabled === false) return
  const file = config.cacheFile ?? defaultCacheFile()
  const cache = config.cache ?? readCache(file, logger)
  const target = config.model ?? {}
  const llm = (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm) as Pick<LlmRuntime, 'stream'> | undefined

  let classifyGroup: ClassifyGroup | undefined
  if (typeof config.classify === 'function') {
    classifyGroup = config.classify   // injected for tests and custom pipelines
  } else if (llm !== undefined && target.provider && target.model) {
    classifyGroup = createLlmCaller(llm, { provider: target.provider, model: target.model, maxTokens: config.maxTokens })
  } else {
    logger.info?.('tool-manager-classifier-llm: no model configured (config.model {provider, model}); groups stay uncategorized')
  }

  // The pump runs in the background, so it can outlive the plugin (DSH is
  // shutting down, or the plugin was unloaded mid-classification). Both the
  // refresh and the cache write must be safe then.
  let live = true
  ctx.effect(() => () => { live = false }, 'tool-manager-classifier-llm.lifetime()')

  const classifier = createLlmClassifier({
    name: config.name ?? 'llm:groups',
    priority: config.priority ?? DEFAULT_PRIORITY,
    cache,
    classifyGroup,
    batchSize: config.batchSize ?? 5,
    logger,
    onBatch: async (next) => {
      writeCache(file, next, logger)
      if (!live) return
      // A new answer changes where a group belongs: rebuild so the model sees it.
      try {
        ctx.toolCatalog.refresh()
      } catch (caught) {
        const error = caught as Error
        logger.warn?.(`tool-manager-classifier-llm: refresh after classifying failed: ${error.message}`)
      }
    },
  })

  ctx.effect(() => ctx.toolCatalog.registerClassifier(classifier), 'tool-manager-classifier-llm.classifier()')

  // --- retrieval: a plain-language request that the keyword search missed ------
  //
  // The core calls this only when the keyword search was weak, so a clear
  // request never reaches the model. Without a configured model there is no
  // fallback at all, and the keyword search answers on its own.
  let pickTools: PickTools | undefined
  if (typeof config.pickTools === 'function') {
    pickTools = config.pickTools
  } else if (llm !== undefined && target.provider && target.model) {
    pickTools = createToolPicker(llm, { provider: target.provider, model: target.model, maxTokens: config.maxTokens })
  }
  if (pickTools && config.retrieval !== false) {
    const fallback = createSearchFallback({
      pickTools,
      maxTools: config.maxRetrievalTools,
      maxCandidates: config.maxRetrievalCandidates,
      logger,
      candidates: () => {
        const catalog = ctx.toolCatalog.get()
        return [...catalog.tools.values()].map((tool) => ({ name: tool.short, summary: tool.summary }))
      },
      lookup: (name) => {
        const catalog = ctx.toolCatalog.get()
        const tool = catalog.tools.get(name) ?? [...catalog.tools.values()].find((t) => t.short === name)
        if (!tool) return undefined
        return {
          name: tool.name,
          short: tool.short,
          path: `/${tool.category}/${tool.group}/${tool.short}`,
          category: tool.category,
          group: tool.group,
          summary: tool.summary,
          tokens: tool.tokens,
          highRisk: tool.highRisk === true,
        }
      },
    })
    ctx.effect(() => ctx.toolCatalog.registerSearchFallback(fallback), 'tool-manager-classifier-llm.retrieval()')
  }

  // Misses are collected while catalogs are built; pump after the build so a
  // rebuild never waits on the network.
  ctx.effect(() => ctx.on('tool-catalog/after-rebuild', () => { void classifier.schedule() }), 'tool-manager-classifier-llm.pump()')

  return { classifier, cache, file, classify: classifyGroup }
}

export default { name, inject, apply }
