// Types shared by the tool-router modules.
//
// The host surface is described structurally (only what this plugin touches)
// instead of importing the host's Cordis types, so the package type-checks
// without the host packages installed next to it.

export type Disposer = () => void

export interface Logger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  debug?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** A tool schema as the host lists it (fallback mode, no toolCatalog). */
export interface ToolSchema {
  name: string
  description?: string
  [key: string]: unknown
}

/** A ref into the tool index, aligned to the index doc id. */
export interface ToolRef {
  name: string
  path: string
  summary: string
  description: string
  group: string
  category: string
  tokens: number
  highRisk: boolean
}

/** A ref into the skill index, aligned to the index doc id. */
export interface SkillRef {
  name: string
  summary: string
  whenToUse: string
  source?: string
  provider?: string
}

/** A ranked hit: a ref plus its BM25 score. */
export interface Hit<T> {
  ref: T
  score: number
}

/** One tool entry as the toolCatalog service lists it. */
export interface CatalogToolEntry {
  name: string
  short: string
  group: string
  category: string
  summary: string
  description: string
  tokens: number
  highRisk?: boolean
}

/** The toolCatalog service surface this plugin uses. */
export interface ToolCatalogService {
  get(): { tools: Map<string, CatalogToolEntry>, groups?: Map<string, { name: string }>, categories?: Map<string, { name: string }> }
  load(agent: unknown, targets: string[]): Promise<string | { ok: false, message: string }>
  wireTokens?(agent: unknown): number
}

/** One message from the llm stream. */
export interface LlmChunk {
  type: string
  text?: string
}

/** The llm service surface this plugin uses. */
export interface LlmService {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: { role: string; content: { type: string; text: string }[] }[]
    maxTokens?: number
    temperature?: number
  }): AsyncIterable<LlmChunk>
}

/** One skill as the skills service lists it. */
export interface SkillEntry {
  name: string
  description?: string
  whenToUse?: string
  source?: string
  provider?: string
  invocation?: { modelInvocable?: boolean }
}

/** The skills service surface this plugin uses. */
export interface SkillsService {
  list(opts?: { cwd?: string; scope?: string }): Promise<SkillEntry[]>
  get(name: string, opts?: { cwd?: string }): Promise<{ content?: string } | undefined>
}

/** A tool definition built by hand (no @deepseek-ai/dsh-tools dependency). */
export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
    additionalProperties: boolean
  }
  output: {
    schema: { type: 'string' }
    render(args: unknown, value: unknown): { type: 'text'; text: string }[]
  }
  execute(args: Record<string, unknown>, exec?: { agent?: unknown }): Promise<string>
  isConcurrencySafe?: () => boolean
}

/** The host context this plugin receives in apply(). */
export interface HostContext {
  tools: {
    schemas(): ToolSchema[]
    register(tool: ToolDef): void
  }
  toolCatalog?: ToolCatalogService
  logger?: ((name: string) => Logger) | Logger
  get?(name: string): unknown
  on(event: string, handler: (...args: any[]) => unknown): Disposer
  effect(fn: () => Disposer | void, label?: string): void
}

/** Configuration of the tool-router plugin. */
export interface RouterConfig {
  /** Model used to re-rank tools_route candidates. */
  model?: { provider?: string; model?: string }
  /** Max tokens for the re-rank call. */
  maxTokens?: number
  /** Default number of results. */
  topK?: number
  /** Token budget for loaded tool schemas. */
  maxBudget?: number
  /** BM25 parameters (JS fallback). */
  k1?: number
  b?: number
  /** Sidecar overrides. */
  sidecar?: { bin?: string; socket?: string; timeoutMs?: number }
}