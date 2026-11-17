// Rule-based classifier for Tool Ultra.
//
// Registers up to two classifiers on the `toolCatalog` service:
//   - "rules:user"     priority 1000 (override tier): config groupRules/categories;
//                      beats plugin declarations.
//   - "rules:defaults" priority 100: built-in rules for tools common on DSH hosts;
//                      plugin declarations beat it.
// Without this plugin the core puts every group under `uncategorized`.

import type { Classifier, Disposer, ExtensionContext } from '@lvy-jsd/dsh-tool-ultra-core'

/** Tools whose name matches `match` (a regular expression) go to `group`. */
export interface GroupRule {
  match: string
  group: string
}

export interface RulesConfig {
  /** Set false to drop the built-in rules. */
  defaults?: boolean
  groupRules?: GroupRule[]
  categories?: Record<string, { description?: string, groups?: string[] }>
}

export interface RulesClassifierOptions {
  name: string
  priority: number
  groupRules?: GroupRule[]
  groupCategories?: Record<string, string>
}

export const name = 'tool-manager-classifier-rules'
export const inject = ['toolCatalog']

export const USER_PRIORITY = 1000
export const DEFAULT_PRIORITY = 100

// Verb-named DSH tools that no name prefix can group.
export const DEFAULT_GROUP_RULES: GroupRule[] = [
  { match: '^(create|list|update|stop|message)_bots?$', group: 'bots' },
  { match: '^((create|delete|update)_group|post_to_group|read_group_chat|read_own_chat|group_relay)$', group: 'groups' },
  { match: '^(spawn_teammate|send_message|open_session|team_task_\\w+|agent_\\w+)$', group: 'team' },
  { match: '^((attach|detach|delete|save|list)_capabilit(y|ies)|create_skill)$', group: 'capability' },
  { match: '^(list_mcp_resources?|list_mcp_resource_templates|read_mcp_resource)$', group: 'mcp-resources' },
  { match: '^(remember|forget|recall)$', group: 'memory' },
  { match: '^(list_secrets|request_secret)$', group: 'secrets' },
  { match: '^(x_search|dsh_subscriptions_x_search)$', group: 'x' },
  { match: '^image_\\w+$', group: 'image' },
  { match: '^nixos_env$', group: 'nix' },
  { match: '^read_page$', group: 'browser' },
]

// Group -> category for groups common on DSH hosts.
export const DEFAULT_GROUP_CATEGORIES: Record<string, string> = {
  adb: 'device', 'adb-root': 'device', phone: 'device', desktop: 'device',
  'phone-control': 'device', 'desktop-eyes': 'device',
  github: 'code', nix: 'code', nixos: 'code',
  'bilibili-mcp': 'media', image: 'media', video: 'media',
  amap: 'maps',
  browser: 'browser', playwright: 'browser', puppeteer: 'browser', 'chrome-devtools': 'browser',
  engram: 'memory', memory: 'memory',
  bots: 'collaboration', groups: 'collaboration', team: 'collaboration', agent: 'collaboration',
  automation: 'automation', schedule: 'automation',
  mcp: 'connectors', mcp_connector: 'connectors', 'mcp-connector': 'connectors', 'mcp-resources': 'connectors',
  x: 'search',
  // MCP servers are grouped by server name; these are the names their READMEs suggest.
  search: 'search', searxng: 'search', 'web-search': 'search', 'brave-search': 'search', tavily: 'search', exa: 'search',
  email: 'mail', mail: 'mail', gmail: 'mail', imap: 'mail', outlook: 'mail',
  secrets: 'system', capability: 'system',
}

// Categories the default rules use that the core's vocabulary lacks. Defined by
// this plugin so the rules work with any core version.
export const DEFAULT_EXTRA_CATEGORIES: Record<string, string> = {
  mail: 'Email: read, search, draft and send mail',
}

/** Build a classifier from rule tables. Pure; exported for tests and reuse. */
export function rulesClassifier({ name, priority, groupRules = [], groupCategories = {} }: RulesClassifierOptions): Classifier {
  const compiled = groupRules.map((r) => ({ re: new RegExp(r.match), group: String(r.group) }))
  return {
    name,
    priority,
    group(tool) {
      for (const rule of compiled) if (rule.re.test(tool.name)) return rule.group
      return undefined
    },
    categorize(group) {
      return groupCategories[group.name]
    },
  }
}

/** Invert config `categories: { cat: { groups: [...] } }` into group -> category. */
export function groupCategoriesFrom(categories: RulesConfig['categories'] = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [category, spec] of Object.entries(categories)) for (const group of spec?.groups ?? []) out[group] = category
  return out
}

export function apply(ctx: ExtensionContext, config: RulesConfig = {}) {
  const catalog = ctx.toolCatalog

  ctx.effect(() => {
    const disposers: Disposer[] = []
    if (config.defaults !== false) {
      for (const [category, description] of Object.entries(DEFAULT_EXTRA_CATEGORIES)) {
        disposers.push(catalog.defineCategory(category, description))
      }
      disposers.push(catalog.registerClassifier(rulesClassifier({
        name: 'rules:defaults',
        priority: DEFAULT_PRIORITY,
        groupRules: DEFAULT_GROUP_RULES,
        groupCategories: DEFAULT_GROUP_CATEGORIES,
      })))
    }
    const userCategories = config.categories ?? {}
    for (const [category, spec] of Object.entries(userCategories)) {
      if (spec?.description) disposers.push(catalog.defineCategory(category, spec.description))
    }
    if ((config.groupRules ?? []).length || Object.keys(userCategories).length) {
      disposers.push(catalog.registerClassifier(rulesClassifier({
        name: 'rules:user',
        priority: USER_PRIORITY,
        groupRules: config.groupRules ?? [],
        groupCategories: groupCategoriesFrom(userCategories),
      })))
    }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, 'tool-manager-classifier-rules')
}

export default { name, inject, apply }
