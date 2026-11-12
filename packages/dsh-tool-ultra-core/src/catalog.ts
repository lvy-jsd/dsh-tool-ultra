// Builds the three-level tool directory: category -> group -> tool.
//
// The core knows no rules. Placement comes from, in order:
//   1. override classifiers (priority >= OVERRIDE_PRIORITY), e.g. user config
//   2. annotations declared by plugins (package.json `dsh.toolCatalog`, annotate())
//   3. ordinary classifiers, highest priority first
//   4. a structural fallback: group from the tool name, category `uncategorized`
//
// Grouping never decides visibility; a misplaced tool is only listed in the
// wrong place, never lost.

import type { Agent, Annotation, Catalog, CatalogNode, Category, Classifier, Group, GroupProbe, RegisteredResolver, ToolEntry, ToolMeta, ToolProbe, ToolSchema } from './types.js'

export const UNCATEGORIZED = 'uncategorized'
export const MISC_GROUP = 'misc'
export const OVERRIDE_PRIORITY = 1000

// The fixed category vocabulary. Plugins may add more with defineCategory().
export const DEFAULT_CATEGORIES: Record<string, string> = {
  device: 'Phones, Android, ADB and desktop control',
  code: 'Source hosting, repositories and package tooling',
  media: 'Video, image and audio services',
  maps: 'Maps, geocoding and routing',
  browser: 'Headless browser automation',
  memory: 'Long-term memory and knowledge stores',
  collaboration: 'Bots, group chats, teammates and other sessions',
  automation: 'Schedules and automated runs',
  connectors: 'MCP connector administration',
  search: 'Web and social search',
  system: 'Host, OS and secrets',
  [UNCATEGORIZED]: 'Tools no classifier has placed yet',
}

// Leading words that describe an action rather than an owner; a shared verb
// prefix ("list_", "get_") is not a meaningful group.
const VERB_PREFIXES = new Set([
  'add', 'ask', 'attach', 'create', 'delete', 'detach', 'edit', 'exit', 'get',
  'interrupt', 'list', 'message', 'open', 'post', 'read', 'remove', 'request',
  'run', 'save', 'send', 'set', 'spawn', 'stop', 'update', 'wait', 'write',
])

/**
 * Structural group for a tool name, used when nothing else places it:
 * `mcp__server__tool` -> server, `mcp__server__sub__tool` -> server-sub,
 * `prefix_rest` -> prefix when at least two tools share a non-verb prefix, else misc.
 */
export function structuralGroup(name: string, prefixCounts: Map<string, number>): string {
  if (name.startsWith('mcp__')) {
    const parts = name.slice(5).split('__')
    if (parts.length >= 3) return `${parts[0]}-${parts[1]}`
    return parts[0]
  }
  const prefix = name.split('_')[0]
  if (prefix !== name && !VERB_PREFIXES.has(prefix) && (prefixCounts.get(prefix) ?? 0) >= 2) return prefix
  return MISC_GROUP
}

/** Short form of a tool name inside its group (drops the MCP routing prefix). */
export function shortName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.slice(5).split('__')
  return parts[parts.length - 1] ?? name
}

/** First sentence of a description, capped for one-line listings. */
export function summary(text: string | undefined, max = 80): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const first = flat.split(/(?<=[.!?。！？])\s/)[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

/** Rough token cost of one schema as the model receives it. */
export function estimateTokens(schema: unknown): number {
  const text = JSON.stringify(schema)
  // CJK and other wide characters cost roughly one token each, not a quarter.
  let wide = 0
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e7f) wide += 1
  return Math.ceil((text.length - wide) / 4 + wide)
}

/** Merge every annotation that applies to `name`; later annotations win per field. */
function annotationFor(name: string, annotations: readonly Annotation[]): ToolMeta {
  let merged: ToolMeta | undefined
  for (const a of annotations) {
    const hit = typeof a.match === 'string' ? a.match === name : a.match.test(name)
    if (hit) merged = { ...merged, ...a.meta }
  }
  return merged ?? {}
}

/**
 * A group a classifier renamed (e.g. attribution-scan: `phone` -> `phone-control`)
 * is unknown to category rules written for the old name. Ask the classifiers
 * about the structural groups its tools came from instead; the category covering
 * the most tools wins.
 */
function inheritedCategory(group: Group, classifiers: readonly Classifier[]): string | undefined {
  const byFallback = new Map<string, ToolEntry[]>()
  for (const tool of group.tools) {
    if (tool.fallbackGroup === group.name) continue
    let list = byFallback.get(tool.fallbackGroup)
    if (!list) byFallback.set(tool.fallbackGroup, (list = []))
    list.push(tool)
  }
  const votes = new Map<string, number>()
  for (const [name, tools] of byFallback) {
    const probe: GroupProbe = { name, tools: tools.map(({ name: n, description, annotation }) => ({ name: n, description, annotation })) }
    const category = firstResult(classifiers, 'categorize', probe)
    if (category && category !== UNCATEGORIZED) votes.set(category, (votes.get(category) ?? 0) + tools.length)
  }
  let best: [string, number] | undefined
  for (const [category, count] of votes) if (!best || count > best[1]) best = [category, count]
  return best?.[0]
}

function firstResult(classifiers: readonly Classifier[], method: 'group', arg: ToolProbe): string | undefined
function firstResult(classifiers: readonly Classifier[], method: 'categorize', arg: GroupProbe): string | undefined
function firstResult(classifiers: readonly Classifier[], method: 'group' | 'categorize', arg: ToolProbe | GroupProbe): string | undefined {
  for (const c of classifiers) {
    const fn = c[method] as ((arg: ToolProbe | GroupProbe) => unknown) | undefined
    if (typeof fn !== 'function') continue
    try {
      const value = fn.call(c, arg)
      if (typeof value === 'string' && value) return value
    } catch {
      // A failing classifier is skipped, never fatal.
    }
  }
  return undefined
}

export interface BuildOptions {
  /** Placement rules; priority >= OVERRIDE_PRIORITY beats plugin declarations. */
  classifiers?: readonly Classifier[]
  annotations?: readonly Annotation[]
  /** Category vocabulary (name -> description). */
  categories?: Record<string, string>
  /** Tool names configured as high risk. */
  highRisk?: readonly string[]
}

/**
 * Build the directory index.
 * @param schemas - catalog tools (pinned already removed)
 */
export function buildCatalog(schemas: readonly ToolSchema[], { classifiers = [], annotations = [], categories = DEFAULT_CATEGORIES, highRisk = [] }: BuildOptions = {}): Catalog {
  const sorted = [...classifiers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const overrides = sorted.filter((c) => (c.priority ?? 0) >= OVERRIDE_PRIORITY)
  const ordinary = sorted.filter((c) => (c.priority ?? 0) < OVERRIDE_PRIORITY)

  const prefixCounts = new Map<string, number>()
  for (const { name } of schemas) {
    const prefix = name.split('_')[0]
    if (prefix !== name) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
  }

  const risky = new Set(highRisk)
  const tools = new Map<string, ToolEntry>()
  const groups = new Map<string, Group>()
  for (const schema of schemas) {
    const meta = annotationFor(schema.name, annotations)
    const probe: ToolProbe = { name: schema.name, description: schema.description ?? '', annotation: meta }
    const group = firstResult(overrides, 'group', probe)
      ?? meta.group
      ?? firstResult(ordinary, 'group', probe)
      ?? structuralGroup(schema.name, prefixCounts)
    const entry: ToolEntry = {
      name: schema.name,
      short: shortName(schema.name),
      group,
      // Where the structural fallback alone would have put it; a renamed group
      // inherits that group's category (see below).
      fallbackGroup: structuralGroup(schema.name, prefixCounts),
      category: UNCATEGORIZED,
      summary: meta.summary ? summary(meta.summary) : summary(schema.description),
      description: schema.description ?? '',
      tokens: estimateTokens(schema),
      highRisk: risky.has(schema.name) || meta.risk === 'high',
      annotation: meta,
    }
    tools.set(schema.name, entry)
    let bucket = groups.get(group)
    if (!bucket) groups.set(group, (bucket = { name: group, category: UNCATEGORIZED, tools: [] }))
    bucket.tools.push(entry)
  }

  for (const group of groups.values()) {
    group.tools.sort((a, b) => a.short.localeCompare(b.short))
    const probe: GroupProbe = { name: group.name, tools: group.tools.map(({ name, description, annotation }) => ({ name, description, annotation })) }
    const annotated = group.tools.map((t) => t.annotation.category).find(Boolean)
    group.category = firstResult(overrides, 'categorize', probe)
      ?? annotated
      ?? firstResult(ordinary, 'categorize', probe)
      ?? inheritedCategory(group, [...overrides, ...ordinary])
      ?? UNCATEGORIZED
    for (const tool of group.tools) tool.category = group.category
  }

  const categoryIndex = new Map<string, Category>()
  for (const [name, description] of Object.entries(categories)) categoryIndex.set(name, { name, description, groups: [] })
  for (const group of groups.values()) {
    let category = categoryIndex.get(group.category)
    if (!category) categoryIndex.set(group.category, (category = { name: group.category, description: '', groups: [] }))
    category.groups.push(group)
  }
  for (const category of categoryIndex.values()) category.groups.sort((a, b) => a.name.localeCompare(b.name))

  return { tools, groups, categories: categoryIndex }
}

/**
 * Resolve a target into catalog nodes.
 * Accepts "/", "/category", "/category/group", "/category/group/tool",
 * a bare category or group name, a full tool name, or a unique short tool name.
 */
/**
 * Resolve a target string to a node.
 *
 * `resolvers` lets a plugin own a prefix (`cap:`, say): each is consulted before
 * the built-in rules and returns a list of target strings to resolve instead, or
 * undefined to pass. A plugin can therefore add a target vocabulary without the
 * core knowing anything about it.
 */
// Path segments are lowercased, but names keep their original case (an MCP
// server called "GitHub"), so lookups must not depend on it. The names stay as
// they are because persisted state stores them.
const findCI = <T extends { name: string }>(map: Map<string, T>, key: string): T | undefined =>
  map.get(key) ?? [...map.values()].find((v) => v.name.toLowerCase() === key)

// An optional caller-only fallback runs last. Alias expansions deliberately use
// only the registered resolvers, preserving their existing target semantics.
export function resolveTarget(catalog: Catalog, raw: unknown, resolvers: readonly Pick<RegisteredResolver, 'prefix' | 'resolve'>[] = [], agent?: Agent, fallback?: Pick<RegisteredResolver, 'prefix' | 'resolve'>): CatalogNode {
  const target = String(raw ?? '').trim()
  for (const resolver of fallback ? [...resolvers, fallback] : resolvers) {
    const { prefix, resolve } = resolver
    if (prefix && !target.startsWith(prefix)) continue
    let expanded: string | string[] | undefined | null
    try {
      expanded = resolve(target, agent)
    } catch {
      continue
    }
    if (expanded === undefined || expanded === null) continue
    const list = Array.isArray(expanded) ? expanded : [expanded]
    const nodes = list.map((one) => resolveTarget(catalog, one, resolvers, agent))
    // A stale/empty namespace alias must not hide a working directory target
    // or turn an unknown name into a successful load of zero tools.
    if (resolver === fallback && !nodes.some((node) => node.kind !== 'root' && toolsUnder(catalog, node).length > 0)) continue
    if (nodes.length === 0) return { kind: 'missing', target }
    if (nodes.length === 1) return nodes[0]!
    // Several targets behind one alias: expose them as a synthetic category so
    // loading, listing and unloading all work through the existing paths.
    const tools = nodes.flatMap((node) => toolsUnder(catalog, node))
    // `aliasTools` is the exact tool list. The node's groups are copies, so
    // loading must use this list rather than subscribe to the group names —
    // otherwise a shared group would drag in every sibling tool.
    return {
      kind: 'category',
      category: { name: target, description: `Alias for ${list.join(', ')}`, groups: groupsOf(tools), alias: list, aliasTools: tools },
    }
  }
  if (target === '' || target === '/') return { kind: 'root' }
  const exact = catalog.tools.get(target)
  if (exact) return { kind: 'tool', tool: exact }
  const parts = target.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map((p) => p.toLowerCase())
  if (parts.length === 1) {
    const only = parts[0]!
    const category = findCI(catalog.categories, only)
    if (category) return { kind: 'category', category }
    const group = findCI(catalog.groups, only)
    if (group) return { kind: 'group', group }
    const byShort = [...catalog.tools.values()].filter((t) => t.short.toLowerCase() === only)
    if (byShort.length === 1) return { kind: 'tool', tool: byShort[0]! }
    return { kind: 'missing', target }
  }
  const [cat = '', grp, tool] = parts
  const category = findCI(catalog.categories, cat)
  if (!category) return { kind: 'missing', target }
  const group = category.groups.find((g) => g.name.toLowerCase() === grp)
  if (!group) return { kind: 'missing', target }
  if (parts.length === 2) return { kind: 'group', group }
  const entry = group.tools.find((t) => t.short.toLowerCase() === tool || t.name.toLowerCase() === tool)
  if (!entry || parts.length > 3) return { kind: 'missing', target }
  return { kind: 'tool', tool: entry }
}

/** Code-point Levenshtein distance (case-sensitive; callers lowercase first). */
function editDistance(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  if (!x.length) return y.length
  if (!y.length) return x.length
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[y.length]
}

/** The names closestNames reads from a catalog (the core Catalog satisfies it). */
export interface NamedCatalog {
  tools: Map<string, { name: string, short: string }>
  groups?: Map<string, { name: string }>
  categories?: Map<string, { name: string }>
}

/**
 * The closest catalog names to a target that resolved to nothing, for a
 * "did you mean" hint. Case-insensitive edit distance over code points (so
 * Chinese names match too); a name that extends the target counts as one edit.
 * Only names within a length-relative threshold are returned, so an unrelated
 * query gets no hint at all. At most `limit` names, closest first.
 */
export function closestNames(catalog: NamedCatalog, target: string, limit = 3): string[] {
  const needle = String(target ?? '').trim().replace(/^\/+/, '').toLowerCase()
  if (!needle) return []
  const candidates = new Set<string>()
  for (const name of [...(catalog.categories?.keys() ?? []), ...(catalog.groups?.keys() ?? []), ...catalog.tools.keys()]) candidates.add(name)
  for (const tool of catalog.tools.values()) candidates.add(tool.short)
  const threshold = Math.min(3, Math.max(1, Math.floor(needle.length / 4)))
  const scored = [...candidates].map((name) => {
    const hay = name.toLowerCase()
    const distance = hay.startsWith(needle) && needle.length >= 2 ? 1 : editDistance(needle, hay)
    return { name, distance }
  }).filter((c) => c.distance <= threshold)
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
  return scored.slice(0, limit).map((c) => c.name)
}

/**
 * Regroup an exact tool list by its original group, for synthetic nodes.
 *
 * The groups are copies holding only the given tools: reusing the catalog's own
 * group objects would drag in every sibling tool, so an alias would load far
 * more than it declares.
 */
function groupsOf(tools: readonly ToolEntry[]): Group[] {
  const byName = new Map<string, Group>()
  for (const tool of tools) {
    let group = byName.get(tool.group)
    if (!group) byName.set(tool.group, (group = { name: tool.group, category: tool.category, tools: [] }))
    if (!group.tools.includes(tool)) group.tools.push(tool)
  }
  return [...byName.values()]
}

/** Tools under a node (whole tree for root). */
export function toolsUnder(catalog: Catalog, node: CatalogNode): ToolEntry[] {
  if (node.kind === 'root') return [...catalog.tools.values()]
  if (node.kind === 'category') return node.category.groups.flatMap((g) => g.tools)
  if (node.kind === 'group') return node.group.tools
  if (node.kind === 'tool') return [node.tool]
  return []
}
