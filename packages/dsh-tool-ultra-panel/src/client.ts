// dsh-tool-ultra-panel — browser half.
//
// A classic script, not a module: tsc only strips the types (see
// tsconfig.client.json), with no bundler. Registers one native section in the
// Settings page sidebar ("Tool manager" / "工具管理") and renders it with React, styled
// only with the host's theme variables (--dsw-alias-*), so it follows every DSH
// theme, light and dark. All data comes from the server half's same-origin
// JSON API (/tool-manager/api) and its event stream (/tool-manager/events).
//
// Copy is registered with the host locale service in English and Chinese and
// switches with the DSH interface language. Category names are translated;
// group and tool names are identifiers and stay as they are.

// The host surface this file touches, described by use: the host's own types
// for these are merge-extensible maps that other packages augment, which a
// standalone build cannot see.
interface ModuleLoader {
  load(registration: { id: string, factory: (require: (specifier: string) => unknown) => Record<string, unknown> }): void
}
type Translate = (key: string) => string
interface PanelSlots {
  inject(name: string, fn: () => () => void): () => void
  register(spec: Record<string, unknown>, component: import('react').ComponentType<{ t?: Translate }>): () => void
}
interface PanelLocale {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): void
  bind(namespace: string): Translate
}
interface ClientContext {
  get(name: string): unknown
  effect(fn: () => void | (() => void), label?: string): void
}

;(window as unknown as { __ModuleLoader__: ModuleLoader }).__ModuleLoader__.load({
  id: '@lvy-jsd/dsh-tool-ultra-panel',
  factory: (require) => {
    const React = require('react') as typeof import('react')
    type ReactNode = import('react').ReactNode
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // JSON shapes of the server half's API (see index.ts).
    interface NodeJson {
      kind: 'root' | 'category' | 'group' | 'tool' | 'missing'
      path: string
      name?: string
      description?: string
      summary?: string
      toolCount?: number
      tokens?: number
      highRisk?: boolean
      children?: NodeJson[]
    }
    interface FoundTool {
      name: string
      short: string
      path: string
      category: string
      group: string
      summary: string
      tokens: number
      highRisk: boolean
    }
    interface SessionRow {
      id: string
      parentId: string | null
      /** Session title; a Bot's name when ds-bot set it. */
      title?: string
      /** The agent's model route (provider/model), when the host exposes it. */
      model?: string
      exempt: boolean
      /** 'file:provider' | 'file:session' | 'config:provider' | '' */
      exemptSource?: string
      visible: number | null
      installed: number
      visibleNow: number
      resultTokens: number
      handoffGroups: string[]
      handoffTools: string[]
      wireTokens: number
      loadedTools: string[]
      groups: string[]
    }
    interface AuditRow {
      at: number
      kind: 'load' | 'unload' | 'config' | 'paused'
      agentId: string
      summary: string
      ok: boolean
    }
    interface ConfigJson {
      paused?: boolean
      pinned?: string[]
      entryTools?: string[]
      extraPinned?: string[]
      unpinned?: string[]
      highRisk?: string[]
      settingsFile?: string
      hasSettings?: boolean
      exemptProviders?: string[]
      exemptSessions?: string[]
      exemptFile?: string
      hasExemptFile?: boolean
    }
    /** The four editable metadata fields, as stored and as applied. */
    interface ToolMetaFields {
      group?: string
      category?: string
      risk?: string
      summary?: string
    }
    interface ToolMetaJson {
      name: string
      found: boolean
      effective: ToolMetaFields
      edited: ToolMetaFields
      declared: ToolMetaFields
      group: string
      category: string
      summary: string
      highRisk: boolean
      path: string
      missing: boolean
    }
    /** One proposed move, as the server half computes it. */
    interface TidySuggestionJson {
      group: string
      current: string
      suggested: string
      tools: string[]
    }
    interface TidyPlanJson {
      suggestions: TidySuggestionJson[]
      rejected: { group: string, answer: string, reason: string }[]
      allowed: string[]
      model: { provider: string, model: string } | null
    }
    interface ExtensionsJson {
      classifiers?: { name: string, priority: number }[]
      filters?: string[]
      riskGates?: string[]
      stateProviders?: string[]
      categories?: string[]
    }
    type Load = (targets: string[]) => Promise<void>
    type Unload = (sessionId: string, targets: string[]) => Promise<void>
    type SaveSettings = (patch: { pinned?: string[], unpin?: string[], highRisk?: string[] }, label: string) => Promise<void>
    type SaveMeta = (name: string, meta: ToolMetaFields, label: string) => Promise<ToolMetaJson>
    type DropMeta = (name: string) => Promise<ToolMetaJson>
    type SetExempt = (sessionId: string, exempt: boolean) => Promise<void>

    const ID = 'tool-manager'
    const NS = 'tool-manager.panel'
    const API = '/tool-manager/api'
    const EVENTS = '/tool-manager/events'

    const en: Record<string, string> = {
      nav: 'Tool manager',
      title: 'Tool manager',
      intro: 'Browse the tool directory, see what each session has loaded and what it costs, and check the configuration.',
      'tab.directory': 'Directory',
      'tab.sessions': 'Sessions',
      'tab.config': 'Configuration',
      'tab.meta': 'Tool metadata',
      'tab.tidy': 'Tidy',
      'tab.packs': 'Packs',
      'packs.none': 'No tool packs are installed. Add @lvy-jsd/dsh-tool-ultra-pack-essentials, -web or -mcp to the profile.',
      'packs.tools': '{n} tools',
      'packs.load': 'Load into session',
      'packs.state.on': 'on',
      'packs.state.waiting': 'waiting',
      'packs.state.off': 'off',
      'packs.state.failed': 'failed',
      'tidy.title': 'One-click tidy',
      'tidy.intro': 'Ask the model to place the groups that are still uncategorized. Nothing is written until you confirm the preview.',
      'tidy.model': 'Model',
      'tidy.noModel': 'No model is configured, so tidy is disabled. Set a default model in DSH, or add a model to this plugin.',
      'tidy.noLlm': 'The llm service is not available on this host, so tidy is disabled.',
      'tidy.pending': '{groups} uncategorized groups · {tools} tools',
      'tidy.nothing': 'Every group already has a category. Nothing to tidy.',
      'tidy.allowed': 'Allowed categories',
      'tidy.ask': 'Ask the model',
      'tidy.asking': 'Asking…',
      'tidy.preview': 'Preview',
      'tidy.confirm': 'Apply {n}',
      'tidy.applying': 'Applying…',
      'tidy.applied': 'Placed {groups} groups ({tools} tools).',
      'tidy.none': 'The model proposed nothing usable.',
      'tidy.rejected': 'Ignored answers',
      'tidy.rejectedLine': '{group}: {answer} — {reason}',
      'tidy.unknownGroup': 'unknown group',
      'tidy.unknownCategory': 'not one of the listed categories',
      'tidy.failed': 'Tidy failed: {message}',
      'tidy.selectAll': 'Select all',
      'tidy.selectNone': 'Select none',
      'tidy.missing': 'Groups no longer in the catalog: {groups}',
      'tidy.col.group': 'Group',
      'tidy.col.move': 'Move',
      'tidy.col.tools': 'Tools',
      'stat': '{n} live sessions · descriptions sent per request: {tokens}',
      offline: 'Panel service offline',
      loading: 'Loading…',
      error: 'Panel error: {message}',
      root: 'root',
      search: 'Search all tools…',
      noMatch: 'No tools match.',
      noPath: 'No such path: {path}',
      tools: '{n} tools',
      tool: '1 tool',
      tokens: '~{n} tok',
      highRisk: 'high risk',
      load: 'Load',
      unload: 'Unload',
      select: 'Select',
      selected: 'Selected',
      selectAll: 'Select all',
      clearSelection: 'Clear',
      selectedCount: '{n} selected',
      loadSelected: 'Load selected',
      unloadSelected: 'Unload selected',
      noSession: 'No live session to load into.',
      loaded: 'Loaded {targets}. Hover for details.',
      unloaded: 'Unloaded {targets}.',
      loadFailed: 'Load failed: {message}',
      unloadFailed: 'Unload failed: {message}',
      noSessions: 'No live sessions right now. Open a conversation, then come back.',
      subagentOf: 'subagent of {id}',
      visible: '{n} visible',
      'exempt': 'not restricted',
      'exemptHint': 'Tools are not restricted for sessions using this model route.',
      'exemptSessionHint': 'This session is listed in the file of sessions whose tools are not restricted.',
      'exemptNote': 'Tools are not restricted in this session; every tool is visible.',
      'exemptOn': 'Do not restrict this session',
      'exemptOff': 'Restrict this session',
      'config.exemptFile': 'Unrestricted sessions file',
      'config.hasExemptFile': 'The file sets which model routes and sessions are not restricted.',
      'config.noExemptFile': 'No file yet; model routes from the plugin settings are in effect. Removing restrictions for a session here creates the file.',
      'config.exemptProviders': 'Routes that are not restricted',
      'config.exemptSessions': 'Sessions that are not restricted',
      'config.exemptSaved': 'Restriction settings saved.',
      'config.exemptFailed': 'Saving restriction settings failed: {message}',
      'sent': 'descriptions sent per request: {tokens}',
      groups: 'Groups',
      loadedTools: 'Tools',
      nothingLoaded: 'Nothing loaded: only the always-on tools are visible.',
      'config.title': 'Configuration',
      'config.pinned': 'Always-on tools',
      'config.pinnedValue': '{n} ({entry} entry tools)',
      'config.defaults': 'Built-in always-on',
      'config.extraPinned': 'Extra always-on',
      'config.unpinned': 'Removed from always-on',
      'config.highRisk': 'High risk',
      'config.empty': 'One tool name per line, or comma-separated',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.revert': 'Revert',
      'config.saved': 'Saved: {label}.',
      'config.saveFailed': 'Saving {label} failed: {message}',
      'config.storedIn': 'Stored in',
      'config.hasSettings': 'The settings file overrides the plugin config for the lists it sets.',
      'config.noSettings': 'No settings file yet; the plugin config is in effect until you save.',
      'meta.title': 'Tool metadata',
      'meta.pick': 'Choose a tool…',
      'meta.load': 'Inspect',
      'meta.hint': 'Type a tool name (or pick one from the Directory) to see and edit its category, group, summary and risk level. Parameters and descriptions come from the host and are not editable here.',
      'meta.notFound': 'This tool is not in the catalog right now; it may be pinned away or belong to a session that is not live.',
      'meta.declared': 'Declared by package',
      'meta.edited': 'Edited here',
      'meta.effective': 'Applied to the model',
      'meta.group': 'Group',
      'meta.category': 'Category',
      'meta.risk': 'Risk level',
      'meta.summary': 'Summary',
      'meta.inherit': 'inherited',
      'meta.riskHigh': 'high',
      'meta.riskNormal': 'normal',
      'meta.save': 'Save metadata',
      'meta.saving': 'Saving…',
      'meta.clear': 'Drop edits',
      'meta.cleared': 'Dropped every edit of {name}.',
      'meta.saved': 'Saved metadata for {name}.',
      'meta.saveFailed': 'Saving metadata for {name} failed: {message}',
      'meta.storedIn': 'Edited metadata is stored in',
      'meta.emptyEdit': 'Leave a field blank to fall back to the declared value.',
      'meta.noTools': 'No tools in the catalog.',
      editMeta: 'Metadata',
      'ext.title': 'Extension points',
      'ext.classifier': 'Classifier',
      'ext.priority': 'priority {n}',
      'ext.filter': 'Visibility filter',
      'ext.riskGate': 'Risk gate',
      'ext.stateProvider': 'State provider',
      'ext.categories': 'Categories',
      none: 'none',
      'category.device': 'Devices',
      'category.code': 'Code',
      'category.media': 'Media',
      'category.maps': 'Maps',
      'category.browser': 'Browser',
      'category.memory': 'Memory',
      'category.collaboration': 'Collaboration',
      'category.automation': 'Automation',
      'category.connectors': 'Connectors',
      'category.search': 'Search',
      'category.system': 'System',
      'category.uncategorized': 'Uncategorized',
      'category.capabilities': 'Capability packs',
      'tab.overview': 'Overview',
      'tab.audit': 'Audit',
      'overview.pause': 'Pause new tool loading',
      'overview.pauseHint': 'Stop loading new tools. Tools already loaded keep working.',
      'overview.firstRun': 'Tools load on demand. Nothing is missing — ask for what you need and it appears.',
      'overview.session': 'Session',
      'overview.visible': 'Tools the model can see right now',
      'overview.installed': 'out of {n} installed',
      'overview.groups': 'Groups loaded for this session',
      'overview.groupsHint': 'These groups make their tools available in this session.',
      'overview.wire': 'Tool descriptions sent every request',
      'overview.wireHint': 'this is what the model is told about its tools, not the whole conversation',
      'overview.result': 'Tool output received',
      'overview.resultHint': 'Estimated tokens in tool output received by this session.',
      'unavailable': 'unavailable',
      'tokenUnit': 'tokens',
      'audit.clear': 'Clear',
      'audit.empty': 'This timeline is per-process, kept only in memory, and clears on restart. No activity yet.',
      'audit.load': 'Loaded',
      'audit.unload': 'Unloaded',
      'audit.config': 'Settings changed',
      'audit.paused': 'Loading blocked by pause',
      'permissions.title': 'What tool permissions mean',
      'permissions.read': 'Read: look at a file',
      'permissions.write': 'Write: change or create a file',
      'permissions.exec': 'Exec: run a command on this machine',
      'permissions.sensitive': 'Sensitive: access a secret, such as an API key',
      'output': 'tool output (estimate): {tokens}',
      'handoff': 'carried over to subagents',
    }
    const zh: Record<string, string> = {
      nav: '工具管理',
      title: '工具管理',
      intro: '浏览工具目录，查看每个会话加载了哪些工具、占用多少 token，并检查配置。',
      'tab.directory': '目录',
      'tab.sessions': '会话',
      'tab.config': '配置',
      'tab.meta': '工具元数据',
      'tab.tidy': '一键整理',
      'tab.packs': '工具包',
      'packs.none': '还没有安装工具包。在配置里加上 @lvy-jsd/dsh-tool-ultra-pack-essentials、-web 或 -mcp。',
      'packs.tools': '{n} 个工具',
      'packs.load': '加载到会话',
      'packs.state.on': '运行中',
      'packs.state.waiting': '等待配置',
      'packs.state.off': '已关闭',
      'packs.state.failed': '启动失败',
      'tidy.title': '一键整理',
      'tidy.intro': '让模型给还没分类的分组安排分类。预览确认之前不会写入任何东西。',
      'tidy.model': '模型',
      'tidy.noModel': '没有配置模型，整理功能不可用。在 DSH 里设置默认模型，或给这个插件指定一个模型。',
      'tidy.noLlm': '这个宿主上没有 llm 服务，整理功能不可用。',
      'tidy.pending': '{groups} 个未分类分组 · {tools} 个工具',
      'tidy.nothing': '所有分组都已经有分类了，没有需要整理的。',
      'tidy.allowed': '可选分类',
      'tidy.ask': '让模型整理',
      'tidy.asking': '正在询问…',
      'tidy.preview': '预览',
      'tidy.confirm': '应用 {n} 项',
      'tidy.applying': '正在写入…',
      'tidy.applied': '已整理 {groups} 个分组（{tools} 个工具）。',
      'tidy.none': '模型没有给出可用的建议。',
      'tidy.rejected': '被忽略的回答',
      'tidy.rejectedLine': '{group}：{answer} —— {reason}',
      'tidy.unknownGroup': '未知分组',
      'tidy.unknownCategory': '不在可选分类里',
      'tidy.failed': '整理失败：{message}',
      'tidy.selectAll': '全选',
      'tidy.selectNone': '全不选',
      'tidy.missing': '目录里已经不存在的分组：{groups}',
      'tidy.col.group': '分组',
      'tidy.col.move': '改为',
      'tidy.col.tools': '工具数',
      'stat': '{n} 个活动会话 · 每次请求发送的工具描述：{tokens}',
      offline: '面板服务离线',
      loading: '加载中…',
      error: '面板出错：{message}',
      root: '根目录',
      search: '搜索全部工具…',
      noMatch: '没有匹配的工具。',
      noPath: '路径不存在：{path}',
      tools: '{n} 个工具',
      tool: '1 个工具',
      tokens: '约 {n} token',
      highRisk: '高危',
      load: '加载',
      unload: '卸载',
      select: '选择',
      selected: '已选择',
      selectAll: '全选',
      clearSelection: '清除',
      selectedCount: '已选 {n} 项',
      loadSelected: '加载选中',
      unloadSelected: '卸载选中',
      noSession: '没有可加载的活动会话。',
      loaded: '已加载 {targets}。悬停查看详情。',
      unloaded: '已卸载 {targets}。',
      loadFailed: '加载失败：{message}',
      unloadFailed: '卸载失败：{message}',
      noSessions: '当前没有活动会话。先开一个对话，再回到这里。',
      subagentOf: '{id} 的子 agent',
      visible: '可见 {n} 个',
      'exempt': '不受限制',
      'exemptHint': '使用此模型路线的会话不限制工具。',
      'exemptSessionHint': '此会话列在配置文件中，其工具不受限制。',
      'exemptNote': '此会话的工具不受限制，所有工具均可见。',
      'exemptOn': '不限制此会话',
      'exemptOff': '限制此会话',
      'config.exemptFile': '不受限制的会话配置文件',
      'config.hasExemptFile': '此文件指定哪些模型路线和会话不受限制。',
      'config.noExemptFile': '尚无此文件；当前使用插件设置中的模型路线。在这里取消某个会话的限制会创建该文件。',
      'config.exemptProviders': '不受限制的模型路线',
      'config.exemptSessions': '不受限制的会话',
      'config.exemptSaved': '已保存限制设置。',
      'config.exemptFailed': '保存限制设置失败：{message}',
      'sent': '每次请求发送的工具描述：{tokens}',
      groups: '组',
      loadedTools: '工具',
      nothingLoaded: '尚未加载任何内容：只有常驻工具可见。',
      'config.title': '配置',
      'config.pinned': '常驻工具',
      'config.pinnedValue': '{n} 个（其中入口工具 {entry} 个）',
      'config.defaults': '内置常驻',
      'config.extraPinned': '额外常驻',
      'config.unpinned': '移出常驻',
      'config.highRisk': '高危',
      'config.empty': '每行一个工具名，也可用逗号分隔',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.revert': '还原',
      'config.saved': '已保存：{label}。',
      'config.saveFailed': '保存{label}失败：{message}',
      'config.storedIn': '保存位置',
      'config.hasSettings': '配置文件会覆盖插件配置中同名列表。',
      'config.noSettings': '尚未生成配置文件；保存之前仍使用插件配置。',
      'meta.title': '工具元数据',
      'meta.pick': '选择工具…',
      'meta.load': '查看',
      'meta.hint': '输入工具名（或在“目录”里选中一个）即可查看并修改它的分类、分组、摘要和风险等级。参数与描述由宿主提供，这里不能修改。',
      'meta.notFound': '该工具当前不在目录中：可能被设为常驻，或所属会话已结束。',
      'meta.declared': '包内声明',
      'meta.edited': '面板修改',
      'meta.effective': '实际生效',
      'meta.group': '分组',
      'meta.category': '分类',
      'meta.risk': '风险等级',
      'meta.summary': '摘要',
      'meta.inherit': '未设置',
      'meta.riskHigh': '高危',
      'meta.riskNormal': '普通',
      'meta.save': '保存元数据',
      'meta.saving': '保存中…',
      'meta.clear': '撤销修改',
      'meta.cleared': '已撤销 {name} 的全部修改。',
      'meta.saved': '已保存 {name} 的元数据。',
      'meta.saveFailed': '保存 {name} 的元数据失败：{message}',
      'meta.storedIn': '修改后的元数据保存在',
      'meta.emptyEdit': '留空表示回落到包内声明的值。',
      'meta.noTools': '目录中没有工具。',
      editMeta: '元数据',
      'ext.title': '扩展点',
      'ext.classifier': '分类器',
      'ext.priority': '优先级 {n}',
      'ext.filter': '可见性过滤器',
      'ext.riskGate': '高危审批',
      'ext.stateProvider': '状态保存',
      'ext.categories': '分类',
      none: '无',
      'category.device': '设备',
      'category.code': '代码',
      'category.media': '媒体',
      'category.maps': '地图',
      'category.browser': '浏览器',
      'category.memory': '记忆',
      'category.collaboration': '协作',
      'category.automation': '自动化',
      'category.connectors': '连接器',
      'category.search': '搜索',
      'category.system': '系统',
      'category.uncategorized': '未分类',
      'category.capabilities': '能力包',
      'categoryDesc.device': '手机、Android、ADB 与桌面控制',
      'categoryDesc.code': '代码托管、仓库与包管理工具',
      'categoryDesc.media': '视频、图片与音频服务',
      'categoryDesc.maps': '地图、地理编码与路线',
      'categoryDesc.browser': '无头浏览器自动化',
      'categoryDesc.memory': '长期记忆与知识库',
      'categoryDesc.collaboration': 'Bot、群聊、队友与其他会话',
      'categoryDesc.automation': '定时任务与自动运行',
      'categoryDesc.connectors': 'MCP 连接器管理',
      'categoryDesc.search': '网页与社交搜索',
      'categoryDesc.system': '主机、系统与密钥',
      'categoryDesc.uncategorized': '尚未被任何分类器归类的工具',
      'categoryDesc.capabilities': '按能力包整体加载的工具组合',
      'tab.overview': '概览',
      'tab.audit': '审计记录',
      'overview.pause': '暂停加载新工具',
      'overview.pauseHint': '停止加载新工具。已加载的工具仍可正常使用。',
      'overview.firstRun': '工具会按需加载。没有缺少任何功能——说出你的需求，相应工具就会出现。',
      'overview.session': '会话',
      'overview.visible': '模型现在能看到的工具',
      'overview.installed': '共安装了 {n} 个工具',
      'overview.groups': '本次会话已加载的工具组',
      'overview.groupsHint': '这些工具组让本次会话可以使用其中的工具。',
      'overview.wire': '每次请求发送的工具描述',
      'overview.wireHint': '这是模型收到的工具说明，不是整段对话。',
      'overview.result': '已收到的工具输出',
      'overview.resultHint': '估算本次会话收到的工具输出所占的 token 数。',
      'unavailable': '不可用',
      'tokenUnit': 'token',
      'audit.clear': '清空',
      'audit.empty': '活动记录仅保留在当前进程的内存中，重启后会清空。目前没有记录。',
      'audit.load': '加载',
      'audit.unload': '卸载',
      'audit.config': '设置变更',
      'audit.paused': '因暂停而未加载',
      'permissions.title': '工具权限的含义',
      'permissions.read': '读取：查看一个文件',
      'permissions.write': '写入：修改或创建一个文件',
      'permissions.exec': '执行：在这台机器上运行命令',
      'permissions.sensitive': '敏感：访问 API 密钥等秘密信息',
      'output': '工具输出（估算）：{tokens}',
      'handoff': '传递给子智能体',
    }

    const CSS = `
.tmp-section{max-width:860px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.tmp-heading{margin:0;font-size:18px;font-weight:600}
.tmp-intro,.tmp-muted{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}
.tmp-tabs{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-end;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.tmp-tab{background:none;border:0;padding:7px 1px 9px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);cursor:pointer;position:relative}
.tmp-tab:hover,.tmp-tab[data-active=true]{color:var(--dsw-alias-label-primary)}
.tmp-tab[data-active=true]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
.tmp-tab:focus-visible,.tmp-btn:focus-visible,.tmp-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tmp-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tmp-grow{flex:1}
.tmp-stat{font-size:12px;color:var(--dsw-alias-label-secondary)}
.tmp-flash{font-size:12px;min-height:18px;color:var(--dsw-alias-state-business-primary)}
.tmp-list{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);overflow:hidden}
.tmp-row{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:13px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.tmp-row:first-child{border-top:0}
.tmp-row[data-nav=true]{cursor:pointer}
.tmp-row[data-nav=true]:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tmp-name{font-weight:500;white-space:nowrap}
.tmp-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.tmp-chip{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.tmp-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));border-color:var(--dsw-alias-state-warn-primary)}
.tmp-chip[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.tmp-btn{font:inherit;font-size:12px;line-height:20px;padding:1px 10px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.tmp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tmp-btn[data-ghost=true]{background:none;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:1px 4px}
.tmp-input{font:inherit;font-size:12px;padding:4px 10px;min-width:220px;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.tmp-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.tmp-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);padding:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}
.tmp-card h3{margin:0;font-size:14px;font-weight:600}
.tmp-table{border-collapse:collapse;font-size:12.5px;width:100%}
.tmp-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top}
.tmp-table td{padding:4px 0;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);word-break:break-word}
.tmp-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:12px 0}
.tmp-field{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.tmp-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.tmp-textarea{font:inherit;font-size:12px;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);padding:6px 10px;resize:vertical;border-radius:var(--dsw-radius-sm,6px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.tmp-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.tmp-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.tmp-mono{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);margin:0;word-break:break-all}
.tmp-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.tmp-number{font-size:28px;font-weight:600;line-height:1.2}
.tmp-audit{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.tmp-audit li{padding:10px 12px;border-left:3px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1)}
.tmp-audit li[data-tone=warn]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.tmp-switch{appearance:none;position:relative;width:34px;height:20px;flex:none;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.tmp-switch:before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.tmp-switch:checked{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.tmp-switch:checked:before{left:16px;background:var(--dsw-alias-bg-layer-1)}
.tmp-switch:disabled{opacity:.6;cursor:default}
.tmp-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.tmp-row input[type=checkbox]{flex:none;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
`
    const CSS_ID = '@lvy-jsd/dsh-tool-ultra-panel/section.css'
    function ensureCss() {
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@lvy-jsd/dsh-tool-ultra-panel'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    async function api<R>(method: string, params?: object): Promise<R & { message?: string }> {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params: params ?? {} }),
      })
      const body = await res.json() as R & { ok?: boolean, message?: string }
      if (!body.ok) throw new Error(body.message || `HTTP ${res.status}`)
      return body
    }

    /** `t` with {placeholders}; falls back to the key so a missing entry is visible, not blank. */
    const format = (t: Translate, key: string, vars?: Record<string, unknown>): string => {
      let text: unknown = t(key)
      if (typeof text !== 'string' || text === '') text = key
      for (const [k, v] of Object.entries(vars ?? {})) text = (text as string).split(`{${k}}`).join(String(v))
      return text as string
    }
    const tokNumber = (n: number | undefined): string => (n !== undefined && n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0))
    // Category descriptions come from the server in English; a translation, when
    // the active dictionary has one, replaces it. English falls through as-is.
    const categoryDescription = (t: Translate, name: string | undefined, fallback: string | undefined): string | undefined => {
      const key = `categoryDesc.${name}`
      const text = t(key)
      return typeof text === 'string' && text && text !== key ? text : fallback
    }
    const categoryLabel = (t: Translate, name: string | undefined): string | undefined => {
      const key = `category.${name}`
      const text = t(key)
      return typeof text === 'string' && text && text !== key ? text : name
    }

    const Chip = ({ tone, title, children }: { tone?: string, title?: string, children?: ReactNode }) => h('span', { className: 'tmp-chip', 'data-tone': tone, title }, children)
    const Button = ({ ghost, onClick, children, title }: { ghost?: boolean, onClick?: () => void, children?: ReactNode, title?: string }) =>
      h('button', { type: 'button', className: 'tmp-btn', 'data-ghost': ghost === true, onClick, title }, children)

    function Directory({ t, path, setPath, load, unload, inspect, version }: { t: Translate, path: string, setPath: (path: string) => void, load: Load, unload: (targets: string[]) => Promise<void>, inspect: (name: string) => void, version: number }) {
      const [root, setRoot] = useState<NodeJson | null>(null)
      const [results, setResults] = useState<FoundTool[] | null>(null)
      const [query, setQuery] = useState('')
      const [error, setError] = useState<string | null>(null)
      // Targets ticked for a batch load/unload. Targets are node paths (which
      // the core resolves to a whole group) or tool names, never both for the
      // same row, so a click on any row is unambiguous.
      const [checked, setChecked] = useState<string[]>([])

      useEffect(() => {
        let live = true
        setResults(null)
        api<{ root: NodeJson }>('tree', { path })
          .then((body) => { if (live) { setRoot(body.root); setError(null) } })
          .catch((e: Error) => { if (live) setError(e.message) })
        return () => { live = false }
      }, [path, version])

      // Selection is per directory listing: navigating elsewhere would leave
      // ticks pointing at rows that are no longer on screen.
      useEffect(() => { setChecked([]) }, [path, version])

      const search = (event: import('react').KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return
        const q = query.trim()
        if (!q) { setResults(null); return }
        api<{ results: FoundTool[] }>('search', { query: q }).then((body) => setResults(body.results)).catch((e: Error) => setError(e.message))
      }

      const toggle = (target: string) => setChecked((all) => (all.includes(target) ? all.filter((x) => x !== target) : [...all, target]))

      const parts = path.split('/').filter(Boolean)
      const crumbs: ReactNode[] = [h(Button, { key: 'root', ghost: true, onClick: () => setPath('/') }, t('root'))]
      parts.forEach((part, i) => {
        const target = `/${parts.slice(0, i + 1).join('/')}`
        crumbs.push(h('span', { key: `s${i}`, className: 'tmp-muted' }, '/'))
        crumbs.push(h(Button, { key: target, ghost: true, onClick: () => setPath(target) }, i === 0 ? categoryLabel(t, part) : part))
      })
      const bar = h('div', { className: 'tmp-bar' }, ...crumbs, h('span', { className: 'tmp-grow' }),
        checked.length
          ? h('span', { className: 'tmp-stat' }, format(t, 'selectedCount', { n: checked.length }))
          : null,
        checked.length
          ? h(Button, { onClick: () => load(checked).then(() => setChecked([])) }, t('loadSelected'))
          : null,
        checked.length
          ? h(Button, { onClick: () => unload(checked).then(() => setChecked([])) }, t('unloadSelected'))
          : null,
        checked.length ? h(Button, { ghost: true, onClick: () => setChecked([]) }, t('clearSelection')) : null,
        h('input', {
          className: 'tmp-input', type: 'search', value: query, placeholder: t('search'),
          onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => setQuery(e.target.value), onKeyDown: search,
        }))

      if (error) return h('div', null, bar, h('div', { className: 'tmp-empty' }, format(t, 'error', { message: error })))
      if (results) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, bar,
          results.length === 0
            ? h('div', { className: 'tmp-empty' }, t('noMatch'))
            : h('div', { className: 'tmp-list' }, results.map((tool) => h('div', { key: tool.name, className: 'tmp-row' },
              h('input', { type: 'checkbox', checked: checked.includes(tool.name), onChange: () => toggle(tool.name), 'aria-label': tool.name }),
              h('span', { className: 'tmp-name' }, tool.path || `/${tool.category}/${tool.group}/${tool.short}`),
              h(Chip, null, format(t, 'tokens', { n: tokNumber(tool.tokens) })),
              tool.highRisk ? h(Chip, { tone: 'warn' }, t('highRisk')) : null,
              h('span', { className: 'tmp-desc', title: tool.summary }, tool.summary),
              h(Button, { onClick: () => load([tool.name]) }, t('load')),
            ))))
      }
      if (!root) return h('div', null, bar, h('div', { className: 'tmp-empty' }, t('loading')))
      if (root.kind === 'missing') return h('div', null, bar, h('div', { className: 'tmp-empty' }, format(t, 'noPath', { path })))

      const rows = root.kind === 'tool' ? [root] : root.children ?? []
      const targets = rows.map((node) => (node.kind === 'tool' ? node.name! : node.path))
      const allChecked = targets.length > 0 && targets.every((x) => checked.includes(x))
      const header = rows.length > 1
        ? h('div', { className: 'tmp-bar' },
          h(Button, { ghost: true, onClick: () => setChecked(allChecked ? [] : targets) }, allChecked ? t('clearSelection') : t('selectAll')))
        : null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, bar, header,
        h('div', { className: 'tmp-list' }, rows.map((node) => {
          const isTool = node.kind === 'tool'
          const target = isTool ? node.name! : node.path
          const label = node.kind === 'category' ? categoryLabel(t, node.name) : node.name
          const description = node.kind === 'category' ? categoryDescription(t, node.name, node.description) : node.description || node.summary
          return h('div', {
            key: node.path ?? node.name, className: 'tmp-row', 'data-nav': !isTool,
            onClick: isTool ? undefined : (e: import('react').MouseEvent) => { if ((e.target as HTMLElement).tagName !== 'BUTTON') setPath(node.path) },
          },
          h('input', { type: 'checkbox', checked: checked.includes(target), onChange: () => toggle(target), 'aria-label': target }),
          h('span', { className: 'tmp-name' }, label + (isTool ? '' : '/')),
          h(Chip, null, isTool ? t('tool') : format(t, 'tools', { n: node.toolCount ?? 0 })),
          h(Chip, null, format(t, 'tokens', { n: tokNumber(node.tokens) })),
          node.highRisk ? h(Chip, { tone: 'warn' }, t('highRisk')) : null,
          h('span', { className: 'tmp-desc', title: description }, description || ''),
          isTool ? h(Button, { ghost: true, onClick: () => inspect(node.name!) }, t('editMeta')) : null,
          h(Button, { onClick: () => load([target]) }, t('load')),
          )
        })))
    }

    function Sessions({ t, sessions, selected, setSelected, unload, setExempt }: { t: Translate, sessions: SessionRow[] | null, selected: string | null, setSelected: (id: string) => void, unload: Unload, setExempt: SetExempt }) {
      if (!sessions) return h('div', { className: 'tmp-empty' }, t('loading'))
      if (sessions.length === 0) return h('div', { className: 'tmp-empty' }, t('noSessions'))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, sessions.map((s) =>
        h('div', { key: s.id, className: 'tmp-card' },
          h('div', { className: 'tmp-bar' },
            h('span', { className: 'tmp-name', title: s.title ?? s.id }, s.title ?? s.id.replace(/^session-/, '').slice(0, 8)),
            s.model ? h(Chip, { title: 'model' }, s.model) : null,
            s.parentId ? h(Chip, null, format(t, 'subagentOf', { id: s.parentId.replace(/^session-/, '').slice(0, 8) })) : null,
            s.exempt
              ? h(Chip, { tone: 'warn', title: `exempt · ${s.exemptSource === 'file:session' ? t('exemptSessionHint') : t('exemptHint')}` }, t('exempt'))
              : h(Chip, null, format(t, 'visible', { n: s.visible ?? 0 })),
            h(Chip, { tone: 'ok', title: 'wireTokens' }, format(t, 'sent', { tokens: format(t, 'tokens', { n: tokNumber(s.wireTokens) }) })),
            h(Chip, { title: 'resultTokens' }, format(t, 'output', { tokens: format(t, 'tokens', { n: tokNumber(s.resultTokens) }) })),
            h('span', { className: 'tmp-grow' }),
            // Per-session exemption is reversible from here: an emptied file
            // restores the plugin config list.
            h(Button, { title: 'exempt', ghost: !s.exempt, onClick: () => setExempt(s.id, !s.exempt) }, s.exempt ? t('exemptOff') : t('exemptOn')),
            h(Button, { ghost: s.id !== selected, onClick: () => setSelected(s.id) }, s.id === selected ? t('selected') : t('select')),
          ),
          s.groups.length
            ? h('div', { className: 'tmp-bar' }, h('span', { className: 'tmp-muted' }, `${t('groups')}:`),
              ...s.groups.map((g) => h('span', { key: g, className: 'tmp-bar' }, h(Chip, null, g),
                h(Button, { ghost: true, onClick: () => unload(s.id, [`/${g}`]) }, t('unload')))))
            : null,
          s.loadedTools.length
            ? h('div', { className: 'tmp-bar' }, h('span', { className: 'tmp-muted' }, `${t('loadedTools')}:`),
              ...s.loadedTools.map((name) => h('span', { key: name, className: 'tmp-bar' }, h(Chip, null, name),
                h(Button, { ghost: true, onClick: () => unload(s.id, [name]) }, t('unload')))))
            : null,
          (s.handoffGroups?.length || s.handoffTools?.length)
            ? h('p', { className: 'tmp-muted', title: 'handoff' }, `${t('handoff')}: ${[...(s.handoffGroups ?? []), ...(s.handoffTools ?? [])].join(', ')}`) : null,
          s.exempt
            ? h('p', { className: 'tmp-muted', title: 'exempt' }, t('exemptNote'))
            : !s.groups.length && !s.loadedTools.length ? h('p', { className: 'tmp-muted' }, t('nothingLoaded')) : null,
        )))
    }

    /**
     * Editable settings. Each list is saved on its own, because the core merges
     * a patch per key: editing one list never rewrites the others.
     */
    function Config({ t, save, external }: { t: Translate, save: SaveSettings, external: number }) {
      const [data, setData] = useState<{ config: ConfigJson, ext: ExtensionsJson } | null>(null)
      const [error, setError] = useState<string | null>(null)
      const [drafts, setDrafts] = useState<Record<string, string>>({})
      const [version, setVersion] = useState(0)
      const [busy, setBusy] = useState<string | null>(null)

      useEffect(() => {
        Promise.all([api<{ config: ConfigJson }>('config'), api<ExtensionsJson>('extensions')])
          .then(([c, e]) => {
            setData({ config: c.config, ext: e })
            setDrafts({
              pinned: (c.config.extraPinned ?? []).join('\n'),
              unpin: (c.config.unpinned ?? []).join('\n'),
              highRisk: (c.config.highRisk ?? []).join('\n'),
            })
            setError(null)
          })
          .catch((e: Error) => setError(e.message))
        // `external` bumps when another panel tab or an outside edit changed the
        // settings, so this tab reloads instead of showing stale values.
      }, [version, external])

      if (error) return h('div', { className: 'tmp-empty' }, format(t, 'error', { message: error }))
      if (!data) return h('div', { className: 'tmp-empty' }, t('loading'))
      const { config, ext } = data
      const list = (xs: string[] | undefined) => (xs && xs.length ? xs.join(', ') : t('none'))
      const row = (k: string, v: ReactNode, key?: string) => h('tr', { key: key ?? k }, h('th', { title: [t('config.exemptProviders'), t('config.exemptSessions')].includes(k) ? 'exempt' : undefined }, k), h('td', null, v))

      // Names may be typed one per line or comma-separated; duplicates and
      // blanks are dropped so the saved list matches what the core expects.
      const parse = (text: string) => [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean))]
      const editor = (key: string, label: string) => h('div', { className: 'tmp-field' },
        h('label', { className: 'tmp-label' }, label),
        h('textarea', {
          className: 'tmp-textarea', rows: 3, value: drafts[key] ?? '', spellCheck: false,
          placeholder: t('config.empty'),
          onChange: (e: import('react').ChangeEvent<HTMLTextAreaElement>) => setDrafts((d) => ({ ...d, [key]: e.target.value })),
        }),
        h('div', { className: 'tmp-bar' },
          h(Button, {
            onClick: async () => {
              setBusy(key)
              try {
                await save({ [key]: parse(drafts[key] ?? '') }, label)
                setVersion((v) => v + 1)
              } finally {
                setBusy(null)
              }
            },
          }, busy === key ? t('config.saving') : t('config.save')),
          h(Button, { ghost: true, onClick: () => setVersion((v) => v + 1) }, t('config.revert')),
        ),
      )

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'tmp-card' }, h('h3', null, t('permissions.title')),
          ...['read', 'write', 'exec', 'sensitive'].map((risk) => h('p', { key: risk, className: 'tmp-muted', title: risk }, t(`permissions.${risk}`)))),
        h('div', { className: 'tmp-card' }, h('h3', null, t('config.title')),
          h('table', { className: 'tmp-table' }, h('tbody', null,
            row(t('config.pinned'), format(t, 'config.pinnedValue', { n: (config.pinned ?? []).length, entry: (config.entryTools ?? []).length })),
            row(t('config.defaults'), list(config.pinned)),
          )),
          editor('pinned', t('config.extraPinned')),
          editor('unpin', t('config.unpinned')),
          editor('highRisk', t('config.highRisk')),
          h('p', { className: 'tmp-muted' }, t('config.storedIn')),
          h('p', { className: 'tmp-mono' }, config.settingsFile ?? ''),
          h('p', { className: 'tmp-muted' }, config.hasSettings ? t('config.hasSettings') : t('config.noSettings'))),
        // The exemption list lives in its own file, edited per session from the
        // Sessions tab; this card only shows what is in force and where from.
        h('div', { className: 'tmp-card' }, h('h3', { title: 'exempt' }, t('config.exemptFile')),
          h('table', { className: 'tmp-table' }, h('tbody', null,
            row(t('config.exemptProviders'), list(config.exemptProviders)),
            row(t('config.exemptSessions'), list(config.exemptSessions)),
          )),
          h('p', { className: 'tmp-mono' }, config.exemptFile ?? ''),
          h('p', { className: 'tmp-muted' }, config.hasExemptFile ? t('config.hasExemptFile') : t('config.noExemptFile'))),
        h('div', { className: 'tmp-card' }, h('h3', null, t('ext.title')),
          h('table', { className: 'tmp-table' }, h('tbody', null,
            ...(ext.classifiers ?? []).map((c) => row(t('ext.classifier'), `${c.name} · ${format(t, 'ext.priority', { n: c.priority })}`, `c:${c.name}`)),
            ...(ext.filters ?? []).map((f) => row(t('ext.filter'), String(f), `f:${f}`)),
            ...(ext.riskGates ?? []).map((g) => row(t('ext.riskGate'), String(g), `g:${g}`)),
            ...(ext.stateProviders ?? []).map((p) => row(t('ext.stateProvider'), String(p), `p:${p}`)),
            row(t('ext.categories'), (ext.categories ?? []).map((c) => categoryLabel(t, c)).join(', '), 'categories'),
          ))))
    }

    /**
     * One-click tidy: preview first, write on confirm.
     *
     * The preview is the whole point of this view. A placement is durable, so a
     * wrong answer is work to undo rather than something that clears itself; the
     * model only proposes, and every row is unticked-able before the write.
     */
    interface ToolPackJson {
      id: string
      title: string
      summary?: string
      source?: string
      tools: string[]
      items: { id: string, title?: string, state: string, detail?: string }[]
    }

    /** Installed tool packs: what each brings, what is waiting for a key, one-click load. */
    function Packs({ t, load, version }: { t: Translate, load: Load, version: number }) {
      const [packs, setPacks] = useState<ToolPackJson[] | null>(null)
      useEffect(() => {
        api<{ packs: ToolPackJson[] }>('toolPacks').then((body) => setPacks(body.packs)).catch(() => setPacks([]))
      }, [version])
      if (!packs) return h('div', { className: 'tmp-empty' }, t('loading'))
      if (packs.length === 0) return h('div', { className: 'tmp-empty' }, t('packs.none'))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        ...packs.map((pack) => h('div', { key: pack.id, className: 'tmp-card' },
          h('div', { className: 'tmp-bar' },
            h('h3', null, pack.title),
            h('span', { className: 'tmp-mono tmp-muted' }, `pack:${pack.id}`),
            h('span', { className: 'tmp-grow' }),
            h('span', { className: 'tmp-muted' }, format(t, 'packs.tools', { n: pack.tools.length })),
            h(Button, { onClick: () => { void load([`pack:${pack.id}`]) }, title: pack.tools.join(', ') }, t('packs.load'))),
          pack.summary ? h('p', { className: 'tmp-muted' }, pack.summary) : null,
          pack.items.length
            ? h('table', { className: 'tmp-table' }, h('tbody', null,
              ...pack.items.map((item) => h('tr', { key: item.id },
                h('th', null, item.title ?? item.id),
                h('td', null, t(`packs.state.${item.state}`)),
                h('td', { className: 'tmp-muted' }, item.detail ?? '')))))
            : null,
          pack.source ? h('p', { className: 'tmp-muted tmp-mono' }, pack.source) : null)))
    }

    function Tidy({ t, onApplied }: { t: Translate, onApplied: () => void }) {
      const [status, setStatus] = useState<{ groups: number, tools: number, allowed: string[], model: { provider: string, model: string } | null } | null>(null)
      const [plan, setPlan] = useState<TidyPlanJson | null>(null)
      const [drop, setDrop] = useState<Record<string, boolean>>({})
      const [busy, setBusy] = useState<'ask' | 'apply' | null>(null)
      const [message, setMessage] = useState<{ text: string, tone?: string } | null>(null)

      const refresh = useCallback(() => {
        api<{ groups: number, tools: number, allowed: string[], model: { provider: string, model: string } | null }>('tidyStatus')
          .then((body) => setStatus({ groups: body.groups, tools: body.tools, allowed: body.allowed, model: body.model }))
          .catch((e: Error) => setMessage({ text: format(t, 'tidy.failed', { message: e.message }), tone: 'warn' }))
      }, [t])

      useEffect(() => { refresh() }, [refresh])

      if (!status) return h('div', { className: 'tmp-empty' }, t('loading'))

      const ask = async () => {
        setBusy('ask')
        setMessage(null)
        try {
          const body = await api<{ plan: TidyPlanJson }>('tidyPreview')
          setPlan(body.plan)
          setDrop({})
          if (body.plan.suggestions.length === 0) setMessage({ text: t('tidy.none'), tone: 'warn' })
        } catch (e) {
          setMessage({ text: format(t, 'tidy.failed', { message: (e as Error).message }), tone: 'warn' })
        } finally {
          setBusy(null)
        }
      }

      const apply = async () => {
        if (!plan) return
        const rows = plan.suggestions.filter((s) => !drop[s.group]).map((s) => ({ group: s.group, suggested: s.suggested }))
        if (rows.length === 0) return
        setBusy('apply')
        try {
          const body = await api<{ applied: { group: string, category: string, tools: number }[], missing: string[] }>('tidyApply', { suggestions: rows })
          const groups = body.applied.length
          const tools = body.applied.reduce((n, row) => n + row.tools, 0)
          const notes = [format(t, 'tidy.applied', { groups, tools })]
          if (body.missing.length) notes.push(format(t, 'tidy.missing', { groups: body.missing.join(', ') }))
          setMessage({ text: notes.join(' · ') })
          setPlan(null)
          refresh()
          onApplied()
        } catch (e) {
          setMessage({ text: format(t, 'tidy.failed', { message: (e as Error).message }), tone: 'warn' })
        } finally {
          setBusy(null)
        }
      }

      const disabledReason = !status.model ? t('tidy.noModel') : null
      const selected = plan ? plan.suggestions.filter((s) => !drop[s.group]).length : 0
      const toggleAll = (on: boolean) => {
        if (!plan) return
        const next: Record<string, boolean> = {}
        for (const s of plan.suggestions) next[s.group] = !on
        setDrop(next)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'tmp-card' }, h('h3', null, t('tidy.title')),
          h('p', { className: 'tmp-muted' }, t('tidy.intro')),
          h('table', { className: 'tmp-table' }, h('tbody', null,
            h('tr', null, h('th', null, t('tidy.pending')), h('td', null, format(t, 'tidy.pending', { groups: status.groups, tools: status.tools }))),
            h('tr', null, h('th', null, t('tidy.model')), h('td', null, status.model ? `${status.model.provider}/${status.model.model}` : t('none'))),
            h('tr', null, h('th', null, t('tidy.allowed')), h('td', null, status.allowed.map((c) => categoryLabel(t, c)).join(', ') || t('none'))),
          )),
          disabledReason ? h('p', { className: 'tmp-muted' }, disabledReason) : null,
          h('div', { className: 'tmp-bar' },
            h(Button, {
              onClick: () => { void ask() },
              title: disabledReason ?? undefined,
            }, busy === 'ask' ? t('tidy.asking') : t('tidy.ask')),
            status.groups === 0 ? h('span', { className: 'tmp-muted' }, t('tidy.nothing')) : null,
          ),
          message ? h('div', { className: 'tmp-flash', role: 'status', 'data-tone': message.tone }, message.text) : null),
        plan
          ? h('div', { className: 'tmp-card' }, h('h3', null, t('tidy.preview')),
            h('div', { className: 'tmp-bar' },
              h(Button, { ghost: true, onClick: () => toggleAll(true) }, t('tidy.selectAll')),
              h(Button, { ghost: true, onClick: () => toggleAll(false) }, t('tidy.selectNone'))),
            h('table', { className: 'tmp-table' }, h('tbody', null,
              h('tr', null, h('th', null, ''), h('th', null, t('tidy.col.group')), h('th', null, t('tidy.col.move')), h('th', null, t('tidy.col.tools'))),
              ...plan.suggestions.map((s) => h('tr', { key: s.group },
                h('td', null, h('input', {
                  type: 'checkbox', checked: !drop[s.group],
                  onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => setDrop((d) => ({ ...d, [s.group]: !e.target.checked })),
                })),
                h('td', null, s.group),
                h('td', null, `${categoryLabel(t, s.current)} → ${categoryLabel(t, s.suggested)}`),
                h('td', null, String(s.tools.length)),
              )),
            )),
            plan.rejected.length
              ? h('div', null,
                h('p', { className: 'tmp-muted' }, t('tidy.rejected')),
                ...plan.rejected.map((r) => h('p', { key: `${r.group}:${r.answer}`, className: 'tmp-muted' },
                  format(t, 'tidy.rejectedLine', {
                    group: r.group,
                    answer: r.answer,
                    reason: r.reason === 'unknown group' ? t('tidy.unknownGroup') : t('tidy.unknownCategory'),
                  }))))
              : null,
            h('div', { className: 'tmp-bar' },
              h(Button, { onClick: () => { void apply() } }, busy === 'apply' ? t('tidy.applying') : format(t, 'tidy.confirm', { n: selected }))),
          )
          : null,
      )
    }

    /** One line describing a metadata layer, so blanks are visible as such. */
    const describe = (meta: ToolMetaFields, t: Translate): string => {
      const parts = [
        meta.category ? `${t('meta.category')}: ${meta.category}` : null,
        meta.group ? `${t('meta.group')}: ${meta.group}` : null,
        meta.risk ? `${t('meta.risk')}: ${meta.risk === 'high' ? t('meta.riskHigh') : meta.risk}` : null,
        meta.summary ? `${t('meta.summary')}: ${meta.summary}` : null,
      ].filter(Boolean)
      return parts.length ? parts.join(' · ') : t('none')
    }

    /**
     * Metadata editor. Everything the model can receive about a tool lives in
     * the four fields below; parameters and the description belong to the host
     * and are shown read-only in the Directory instead. Fields are submitted
     * whole, so clearing one falls back to its declared value.
     */
    function MetaEditor({ t, initial, tools, save, drop }: { t: Translate, initial: string | null, tools: string[], save: SaveMeta, drop: DropMeta }) {
      const [name, setName] = useState(initial ?? '')
      const [data, setData] = useState<{ meta: ToolMetaJson, metadataFile: string } | null>(null)
      const [drafts, setDrafts] = useState<Record<string, string>>({})
      const [error, setError] = useState<string | null>(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback((wanted: string) => {
        const value = wanted.trim()
        if (!value) return
        api<{ meta: ToolMetaJson, metadataFile: string }>('toolMeta', { tool: value })
          .then((body) => {
            setData(body)
            // The draft starts from the edited value when there is one, so the
            // form shows what is actually applied rather than the declaration.
            setDrafts({
              group: body.meta.edited.group ?? '',
              category: body.meta.edited.category ?? '',
              risk: body.meta.edited.risk ?? '',
              summary: body.meta.edited.summary ?? '',
            })
            setError(null)
          })
          .catch((e: Error) => setError(e.message))
      }, [])

      useEffect(() => { if (initial) { setName(initial); load(initial) } }, [initial, load])

      // A save sends the whole form, so the entry the core returns is what the
      // panel shows next: no guessing about which field it kept.
      const submit = async () => {
        const value = name.trim()
        if (!value) return
        setBusy(true)
        try {
          const body = await save(value, { group: drafts.group ?? '', category: drafts.category ?? '', risk: drafts.risk ?? '', summary: drafts.summary ?? '' }, value)
          setData({ meta: body, metadataFile: data?.metadataFile ?? '' })
          setDrafts({
            group: body.edited.group ?? '',
            category: body.edited.category ?? '',
            risk: body.edited.risk ?? '',
            summary: body.edited.summary ?? '',
          })
        } catch {
          // save() already reported the failure; keep the draft for a retry.
        } finally {
          setBusy(false)
        }
      }
      const revert = async () => {
        const value = name.trim()
        if (!value) return
        setBusy(true)
        try {
          const body = await drop(value)
          setData({ meta: body, metadataFile: data?.metadataFile ?? '' })
          setDrafts({ group: '', category: '', risk: '', summary: '' })
        } finally {
          setBusy(false)
        }
      }

      const field = (key: string, label: string) => h('div', { className: 'tmp-field' },
        h('label', { className: 'tmp-label' }, label),
        h('input', {
          className: 'tmp-input', type: 'text', value: drafts[key] ?? '', spellCheck: false,
          placeholder: t('meta.inherit'),
          onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => setDrafts((d) => ({ ...d, [key]: e.target.value })),
        }))

      return h('div', { className: 'tmp-card' }, h('h3', null, t('meta.title')),
        h('p', { className: 'tmp-muted' }, t('meta.hint')),
        h('div', { className: 'tmp-bar' },
          h('input', {
            className: 'tmp-input', type: 'text', list: 'tmp-tool-names', value: name, placeholder: t('meta.pick'), spellCheck: false,
            onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => setName(e.target.value),
            onKeyDown: (e: import('react').KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') load(name) },
          }),
          h('datalist', { id: 'tmp-tool-names' }, ...tools.map((n) => h('option', { key: n, value: n }))),
          h(Button, { onClick: () => load(name) }, t('meta.load')),
        ),
        error ? h('p', { className: 'tmp-empty' }, format(t, 'error', { message: error })) : null,
        data && data.meta.missing ? h('p', { className: 'tmp-muted' }, t('meta.notFound')) : null,
        data
          ? h('div', null,
            h('table', { className: 'tmp-table' }, h('tbody', null,
              h('tr', null, h('th', null, t('meta.effective')), h('td', null, `${data.meta.path || data.meta.name}${data.meta.highRisk ? ` · ${t('highRisk')}` : ''}`)),
              h('tr', null, h('th', null, t('meta.declared')), h('td', null, describe(data.meta.declared, t))),
              h('tr', null, h('th', null, t('meta.edited')), h('td', null, describe(data.meta.edited, t))),
            )),
            field('group', t('meta.group')),
            field('category', t('meta.category')),
            field('summary', t('meta.summary')),
            field('risk', t('meta.risk')),
            h('p', { className: 'tmp-muted' }, t('meta.emptyEdit')),
            h('div', { className: 'tmp-bar' },
              h(Button, { onClick: submit }, busy ? t('meta.saving') : t('meta.save')),
              h(Button, { ghost: true, onClick: revert }, t('meta.clear')),
            ),
            h('p', { className: 'tmp-muted' }, t('meta.storedIn')),
            h('p', { className: 'tmp-mono' }, data.metadataFile),
          )
          : null,
      )
    }

    function Overview({ t, sessions, selected, setSelected, config, audit, pause, busy }: {
      t: Translate, sessions: SessionRow[] | null, selected: string | null, setSelected: (id: string) => void,
      config: ConfigJson | null, audit: AuditRow[] | null, pause: (value: boolean) => Promise<void>, busy: boolean,
    }) {
      const session = sessions?.find((s) => s.id === selected)
      const number = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
      const metric = (key: string, value: number | null | undefined, sentence: string, title?: string) =>
        h('div', { key, className: 'tmp-card', title },
          h('h3', null, t(`overview.${key}`)),
          h('div', { className: 'tmp-number' }, number(value),
            (key === 'wire' || key === 'result') && number(value) !== '—' ? h('span', { className: 'tmp-stat' }, ` ${t('tokenUnit')}`) : null),
          h('p', { className: 'tmp-muted' }, number(value) === '—' ? t('unavailable') : sentence))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { className: 'tmp-card' },
          h('label', { className: 'tmp-bar' },
            h('input', { className: 'tmp-switch', type: 'checkbox', role: 'switch', checked: config?.paused === true,
              disabled: !config || busy, onChange: (e: import('react').ChangeEvent<HTMLInputElement>) => { void pause(e.target.checked) } }),
            t('overview.pause')),
          h('p', { className: 'tmp-muted' }, t('overview.pauseHint')),
          !config ? h('p', { className: 'tmp-muted' }, t('unavailable')) : null),
        audit?.length === 0 ? h('p', { className: 'tmp-intro' }, t('overview.firstRun')) : null,
        sessions?.length ? h('label', { className: 'tmp-bar' }, t('overview.session'),
          h('select', { className: 'tmp-input', value: selected ?? '', onChange: (e: import('react').ChangeEvent<HTMLSelectElement>) => setSelected(e.target.value) },
            ...sessions.map((s) => h('option', { key: s.id, value: s.id }, s.title ?? s.id)))) : null,
        sessions?.length === 0 ? h('p', { className: 'tmp-muted' }, t('noSessions')) : null,
        h('div', { className: 'tmp-metrics' },
          metric('visible', session?.visibleNow, session && Number.isFinite(session.installed) ? format(t, 'overview.installed', { n: session.installed }) : t('unavailable')),
          metric('groups', session?.groups.length, t('overview.groupsHint')),
          metric('wire', session?.wireTokens, t('overview.wireHint'), 'wireTokens'),
          metric('result', session?.resultTokens, t('overview.resultHint'), 'resultTokens')))
    }

    function Audit({ t, entries, clear }: { t: Translate, entries: AuditRow[] | null, clear: () => Promise<void> }) {
      const [busy, setBusy] = useState(false)
      return h('div', { className: 'tmp-card' },
        h('div', { className: 'tmp-bar' }, h('h3', null, t('tab.audit')), h('span', { className: 'tmp-grow' }),
          h('button', { type: 'button', className: 'tmp-btn', disabled: busy || !entries?.length,
            onClick: async () => { setBusy(true); try { await clear() } finally { setBusy(false) } } }, t('audit.clear'))),
        entries === null ? h('p', { className: 'tmp-muted' }, t('unavailable'))
          : entries.length === 0 ? h('p', { className: 'tmp-muted' }, t('audit.empty'))
            : h('ol', { className: 'tmp-audit' }, ...entries.map((entry, i) =>
              h('li', { key: `${entry.at}:${i}`, 'data-tone': entry.kind === 'paused' && !entry.ok ? 'warn' : undefined, title: entry.agentId },
                h('time', { dateTime: new Date(entry.at).toISOString() }, new Date(entry.at).toLocaleTimeString()),
                ` · ${t(`audit.${entry.kind}`)} · ${entry.summary}`))))
    }

    function ToolManagerSection({ t }: { t: Translate }) {
      ensureCss()
      const [tab, setTab] = useState('overview')
      const [path, setPath] = useState('/')
      const [sessions, setSessions] = useState<SessionRow[] | null>(null)
      const [config, setConfig] = useState<ConfigJson | null>(null)
      const [audit, setAudit] = useState<AuditRow[] | null>(null)
      const [pauseBusy, setPauseBusy] = useState(false)
      const [selected, setSelected] = useState<string | null>(null)
      const [version, setVersion] = useState(0)
      const [settingsVersion, setSettingsVersion] = useState(0)
      const [inspectName, setInspectName] = useState<string | null>(null)
      // Bumped on every inspect, so clicking "Metadata" twice on the same tool
      // remounts the editor instead of leaving the previous form on screen.
      const [inspectTick, setInspectTick] = useState(0)
      const [tools, setTools] = useState<string[]>([])
      const [flash, setFlash] = useState<{ message: string, detail?: string } | null>(null)
      const [offline, setOffline] = useState(false)
      const timer = useRef(0)

      // The core's load/unload text is written for the model (English); the panel
      // shows its own localized line and keeps that text as the tooltip.
      const say = useCallback((message: string, detail?: string) => {
        setFlash({ message, detail })
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setFlash(null), 6000)
      }, [])

      const refreshSessions = useCallback(() => {
        api<{ sessions: SessionRow[] }>('sessions')
          .then((body) => { setSessions(body.sessions); setOffline(false) })
          .catch(() => { setSessions(null); setOffline(true) })
      }, [])

      const refreshAudit = useCallback(() => {
        api<{ entries: AuditRow[] }>('audit').then((body) => setAudit(body.entries)).catch(() => setAudit(null))
      }, [])
      const refreshConfig = useCallback(() => {
        api<{ config: ConfigJson }>('config').then((body) => setConfig(body.config)).catch(() => setConfig(null))
      }, [])
      useEffect(() => { refreshConfig() }, [refreshConfig, settingsVersion])
      const pause = async (paused: boolean) => {
        setPauseBusy(true)
        try {
          const body = await api<{ config: ConfigJson }>('updateConfig', { settings: { paused } })
          setConfig(body.config)
          setSettingsVersion((v) => v + 1)
          refreshAudit()
        } catch (e) {
          say(format(t, 'config.saveFailed', { label: t('overview.pause'), message: (e as Error).message }))
          refreshConfig()
        } finally { setPauseBusy(false) }
      }
      const clearAudit = async () => {
        try {
          const body = await api<{ entries: AuditRow[] }>('clearAudit')
          setAudit(body.entries)
        } catch (e) { say(format(t, 'error', { message: (e as Error).message })) }
      }

      // The name picker is filled from the catalog rather than from the current
      // directory listing, so a tool can be inspected from any tab.
      const refreshTools = useCallback(() => {
        api<{ tools: string[] }>('toolNames').then((body) => setTools(body.tools)).catch(() => setTools([]))
      }, [])

      useEffect(() => { refreshTools() }, [refreshTools, version])

      useEffect(() => {
        refreshSessions()
        refreshAudit()
        const interval = setInterval(() => { refreshSessions(); refreshAudit(); refreshConfig() }, 15000)
        let events: EventSource | undefined
        try {
          events = new EventSource(EVENTS)
          events.addEventListener('state', refreshSessions)
          events.addEventListener('audit', refreshAudit)
          events.addEventListener('catalog', () => setVersion((v) => v + 1))
          events.addEventListener('config', () => setSettingsVersion((v) => v + 1))
          events.addEventListener('packs', () => setVersion((v) => v + 1))
          // An edit from another tab rebuilds the catalog, so the tool list and
          // the current entry are refreshed rather than left stale.
          events.addEventListener('metadata', () => { setVersion((v) => v + 1); refreshTools() })
        } catch {
          // No event stream: the interval still refreshes.
        }
        return () => { clearInterval(interval); events?.close(); clearTimeout(timer.current) }
      }, [refreshSessions, refreshTools, refreshAudit, refreshConfig])

      const target = sessions?.some((s) => s.id === selected) ? selected : sessions?.[0]?.id ?? null
      const load: Load = async (targets) => {
        if (!target) return say(t('noSession'))
        try {
          const body = await api<object>('load', { sessionId: target, targets })
          say(format(t, 'loaded', { targets: targets.join(', ') }), body.message)
          refreshSessions()
        } catch (e) {
          say(format(t, 'loadFailed', { message: (e as Error).message }))
        }
      }
      const unload: Unload = async (sessionId, targets) => {
        try {
          const body = await api<object>('unload', { sessionId, targets })
          say(format(t, 'unloaded', { targets: targets.join(', ') }), body.message)
          refreshSessions()
        } catch (e) {
          say(format(t, 'unloadFailed', { message: (e as Error).message }))
        }
      }
      /** Batch unload from the Directory tab, which acts on the selected session. */
      const unloadInDirectory = async (targets: string[]) => {
        if (!target) return say(t('noSession'))
        await unload(target, targets)
      }
      const setExempt: SetExempt = async (sessionId, exempt) => {
        try {
          await api<object>('setExemptSession', { sessionId, exempt })
          say(t('config.exemptSaved'))
          setSettingsVersion((v) => v + 1)
          refreshSessions()
        } catch (e) {
          say(format(t, 'config.exemptFailed', { message: (e as Error).message }))
        }
      }
      const save: SaveSettings = async (patch, label) => {
        try {
          await api<object>('updateConfig', { settings: patch })
          say(format(t, 'config.saved', { label }))
        } catch (e) {
          say(format(t, 'config.saveFailed', { message: (e as Error).message }))
          throw e
        }
      }
      const saveMeta: SaveMeta = async (name, meta, label) => {
        try {
          const body = await api<{ meta: ToolMetaJson }>('updateToolMeta', { tool: name, meta })
          say(format(t, 'meta.saved', { name: label }))
          setVersion((v) => v + 1)
          refreshTools()
          return body.meta
        } catch (e) {
          say(format(t, 'meta.saveFailed', { name: label, message: (e as Error).message }))
          throw e
        }
      }
      const dropMeta: DropMeta = async (name) => {
        const body = await api<{ meta: ToolMetaJson }>('clearToolMeta', { tool: name })
        say(format(t, 'meta.cleared', { name }))
        setVersion((v) => v + 1)
        refreshTools()
        return body.meta
      }
      // The Directory tab hands a tool to the metadata editor and switches tab,
      // so "Metadata" is one click rather than a name to retype.
      const inspect = (name: string) => { setInspectName(name); setInspectTick((v) => v + 1); setTab('meta') }

      const totalTokens = (sessions ?? []).reduce((n, s) => n + (s.wireTokens ?? 0), 0)
      const tabs = ['overview', 'directory', 'packs', 'sessions', 'config', 'meta', 'tidy', 'audit']
      return h('div', { className: 'tmp-section' },
        h('h2', { className: 'tmp-heading' }, t('title')),
        h('p', { className: 'tmp-intro' }, t('intro')),
        h('div', { className: 'tmp-tabs', role: 'tablist' },
          ...tabs.map((id) => h('button', {
            key: id, type: 'button', role: 'tab', className: 'tmp-tab', 'data-active': tab === id, 'aria-selected': tab === id,
            onClick: () => setTab(id),
          }, t(`tab.${id}`))),
          h('span', { className: 'tmp-grow' }),
          h('span', { className: 'tmp-stat', style: { paddingBottom: 9 } },
            offline ? t('offline') : !sessions ? t('loading') : format(t, 'stat', { n: (sessions ?? []).length, tokens: format(t, 'tokens', { n: tokNumber(totalTokens) }) }))),
        h('div', { className: 'tmp-flash', role: 'status', title: flash?.detail }, flash?.message ?? ''),
        tab === 'overview' ? h(Overview, { t, sessions, selected: target, setSelected, config, audit, pause, busy: pauseBusy })
          : tab === 'audit' ? h(Audit, { t, entries: audit, clear: clearAudit })
          : tab === 'directory' ? h(Directory, { t, path, setPath, load, unload: unloadInDirectory, inspect, version })
          : tab === 'sessions' ? h(Sessions, { t, sessions, selected: target, setSelected, unload, setExempt })
            : tab === 'meta' ? h(MetaEditor, { key: inspectTick, t, initial: inspectName, tools, save: saveMeta, drop: dropMeta })
              : tab === 'packs' ? h(Packs, { t, load, version })
              : tab === 'tidy' ? h(Tidy, { t, onApplied: () => { setVersion((v) => v + 1); refreshSessions() } })
                : h(Config, { t, save, external: settingsVersion }),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx: ClientContext) {
      const slots = ctx.get('slots') as PanelSlots | undefined
      const locale = ctx.get('locale') as PanelLocale | undefined
      if (slots === undefined) return
      if (locale) ctx.effect(() => locale.register(NS, { en, zh }), 'tool-manager-panel: dictionaries')
      const bound: Translate = locale ? locale.bind(NS) : (key) => en[key] ?? key
      // The host passes `t` for a slot registered with `locale`; fall back to
      // our own binding so the section renders either way.
      const Section = (props: { t?: Translate }) => h(ToolManagerSection, { ...props, t: props.t ?? bound })
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: ID,
        order: 40,
        label: () => bound('nav'),
        locale: NS,
      }, Section)), 'tool-manager-panel: settings section')
    }

    // ToolManagerSection and NS are exported so another entry point (for example
    // dsh-tool-manager-dsbot-entry) can render the same panel elsewhere.
    return { name: ID, inject, apply, ToolManagerSection, NS }
  },
})
