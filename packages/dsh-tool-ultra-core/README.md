# @lvy-jsd/dsh-tool-ultra-core

Browse every DeepSeek Harness tool as a directory and load tools on demand.

A DSH host with many plugins and MCP connectors sends every tool schema to the
model on every request. This plugin hides everything except a small always-on
set and gives the model three entry tools to find and load the rest:

```
tools_ls("/")                       # categories
tools_ls("/code")                   # groups (a connector or plugin)
tools_ls("/code/github")            # tools, with a one-line summary and schema size
tools_ls({ query: "pull request" }) # search the whole tree in one step
tools_load(["/code/github"])        # callable from the next step, for the rest of the session
tools_load(["mcp__github__get_me"]) # or one tool by exact name
tools_load(["web"])                 # bare pack/cap/device name, first match
tools_unload(["/code/github"])
tools_find("send an email")         # ranked matches by intent (BM25), no loading
tools_route("send an email")        # retrieve, re-rank with the model, then load
```

Loaded tools are **native**: the model receives their full parameter schema
and calls them directly. Nothing is proxied.

Bare names try registered `pack:` → `cap:` → `device:` resolvers, stopping at the first non-empty expansion before normal directory lookup; paths and explicit prefixes keep their existing behavior and plugin ownership.

The core ships **no placement rules**. Without an extension every group is
listed under `uncategorized/` — still fully browsable and loadable. Install
[`dsh-tool-ultra-classifier-rules`](../dsh-tool-ultra-classifier-rules) for
built-in rules and config overrides, or write your own classifier.

## How it works

- Visibility is a per-agent allowlist installed with the host's
  `agent.ctx.tools.restrict({ allow })`:
  `allow = (pinned ∪ loaded tools ∪ tools of loaded groups) ∩ registered tools`,
  then narrowed by any registered visibility filters.
  Tools that appear later (an MCP server reconnecting, a new plugin, a renamed
  tool) stay hidden until loaded.
- Loading a group subscribes to it: tools the group gains later become visible
  too.
- Restrictions from other plugins intersect with this one, so a hard deny (for
  example the MCP connector's governance policy) always wins. A pinned or
  loaded tool that another layer still hides is marked `[denied]` in
  `tools_ls`, and `tools_load` reports it as not callable instead of listing it
  (with one log warning per tool, pointing at connector governance rules and
  per-session injection).
- DSH's PTC mode (`DSH_TOOLS_MODE=ptc` on DSH 0.2.1, the
  `tool-executor-ptc` profile row from 0.2.2) works unchanged: the model gets only
  `run_code`, and the SDK the host declares for it is built from the same
  narrowed view, so loads show up there from the next step. `run_code` itself
  is a host transport and never enters the directory.
- A direct call of a hidden ordinary tool loads it. On DSH 0.2.1 the call then
  runs; DSH 0.2.2 fixes a step's callable tools when the step starts, so there
  the call is refused with "it is loaded now: call it again" and the retry runs.
- Every agent is restricted separately. A subagent starts from the pinned set
  plus whatever the parent loaded with `forSubagents: true`.
- Loaded state is in memory. Install
  [`dsh-tool-ultra-persist`](../dsh-tool-ultra-persist) to save it per
  session and restore it when the session resumes.
- If the plugin is unloaded, all its restrictions are lifted (fail open to
  "every tool visible", never to "no tools").

## Finding and routing by intent

The directory above is browsable, but the model still has to guess the right
keywords and spend turns searching. The core now ships a retrieval + routing
layer that makes an unbounded catalog usable without that guesswork:

```
tools_find("send an email")     # ranked matches (BM25), no loading
tools_route("send an email")    # retrieve, re-rank with the model, then load
skills_find("write a PR")       # ranked skills, no loading
skills_route("write a PR")      # retrieve, re-rank, then load the top skill's body
```

Retrieval is BM25 by default: no model, no network, works offline, and scales
to a large catalog. The BM25 index lives in a Rust sidecar process
(`sidecar/`, tantivy over a Unix socket) for headroom — the hot path is native
and the TypeScript here is a thin client. A dependency-free JS BM25 index is
kept as the always-available fallback, so retrieval never breaks if the sidecar
binary is missing or the process dies.

When a model is configured (`config.model { provider, model }`), `tools_route`
and `skills_route` re-rank the BM25 candidates with the model, so a
natural-language intent that shares no words with a tool name still finds it —
the RAG-MCP pattern: retrieve a small candidate set, then rank it. Any model
failure falls back to the BM25 order, so the router never breaks on a model
hiccup.

The router reuses the core's `toolCatalog` service: it indexes the same
catalog, loads through the same path, and reports the same token budget. The
sidecar is spawned by the plugin and exits with it (a parent-process monitor
kills it on a DSH restart).

## Configuration

```yaml
- id: tool-manager
  name: '@lvy-jsd/dsh-tool-ultra-core'
  config:
    pinned: []      # extra always-on tools (core DSH tools are built in)
    unpin: []       # built-in always-on tools to move into the directory
    exemptProviders: [claude-code]  # routes never narrowed (tool list fixed at session start)
    highRisk: []    # never included in group loads; load individually
```

### Override files

Three files under `$DSH_HOME/tool-manager/` override the config above. Each is
read at startup and re-read when the settings panel saves through the API (or
`reload*` is called); write them from the panel, or by hand and then reload.

| File | Config key it replaces | What it holds |
|---|---|---|
| `settings.json` | `pinned`, `unpin`, `highRisk` | the lists an operator edits most often |
| `metadata.json` | `annotate()` for the same tool | `{ "<tool>": { "group", "category", "risk", "summary" } }` |
| `exempt.json` | `exemptProviders` | `{ "providers": [...], "sessions": [...] }` |

### The tool manifest

A client that receives its tool list once per session — Claude Code, driven by
`dsh-oh-my-claude` — cannot discover the directory by asking, because nothing
tells it the directory exists. So the catalog is also written out as text, to
`~/.claude/dsh-tool-catalog.md`, after every rebuild:

```
## device (14 tools, Devices)

### adb — load with `tools_load({ targets: ["/device/adb"] })`
- adb_install — Install an APK on a device.
- adb_shell ! — Run a shell command on a device.
```

The file opens by saying the listed tools are **not callable yet**, then gives
the two calls that change that (`tools_ls`, `tools_load`) and the rule to load
the smallest thing that covers the task. A `!` marks a high-risk tool. Reading
it runs nothing.

Add one line to `~/.claude/CLAUDE.md` so every Claude session reads it:

```
@~/.claude/dsh-tool-catalog.md
```

The write is skipped when the text did not change, so a rebuild that moves
nothing does not cost a prompt re-read. `manifestFile` points it elsewhere, and
`''` turns it off.

The files win as a whole, not key by key: once `exempt.json` exists, the config
list is ignored rather than merged, so what the file shows is what is in force.
A missing file means "no opinion, use the config"; a corrupt file is reported as
a warning and treated as empty rather than silently restoring the config.
`sessions` exempts one session by id for its remaining lifetime, for checking
whether a client handles late loading without de-exempting the whole route.

A tool's `metadata.json` entry replaces the previous entry as a whole:
submitting the form with a field blank drops that override, and the package
declaration (or a classifier) applies again. `parameters` are deliberately not
part of it — the host owns the schema sent to the model.

## Extending: the `toolCatalog` service

Declare `inject: ['toolCatalog']` (or use `ctx.inject(['toolCatalog'], …)` for
an optional dependency) and register inside an effect so that unloading your
plugin undoes the registration.

### Classifiers

A classifier may place tools into groups and/or groups into categories.
Return `undefined` to pass.

```js
export const name = 'my-classifier'
export const inject = ['toolCatalog']
export function apply(ctx) {
  ctx.effect(() => ctx.toolCatalog.registerClassifier({
    name: 'my-classifier',
    priority: 200,
    group: (tool) => (tool.name.startsWith('lingshu_') ? 'lingshu' : undefined),
    categorize: (group) => (group.name === 'lingshu' ? 'system' : undefined),
  }))
}
```

Resolution order: classifiers with `priority >= 1000` (user overrides) →
plugin declarations → other classifiers, highest priority first → structural
fallback (`mcp__server__…` → `server`, shared `prefix_` → `prefix`, else
`misc`; category `uncategorized`). A classifier that throws is skipped.

### Declaring your own tools

Plugin authors know their tools best. Declare them in your `package.json`:

```json
{
  "dsh": {
    "toolCatalog": {
      "match": "^adb_",
      "group": "adb",
      "category": "device",
      "tools": { "adb_install": { "risk": "high", "summary": "Install an APK." } }
    }
  }
}
```

or at runtime:

```js
ctx.effect(() => ctx.toolCatalog.annotate('^adb_', { category: 'device' }))
ctx.effect(() => ctx.toolCatalog.annotate('adb_install', { risk: 'high' }))
```

Fields: `group`, `category`, `risk` (`"high"`), `summary`. Exact-name entries
win over `match`; runtime annotations win over `package.json`.

### Self-declaration on the tool schema

A third-party plugin can also declare its tools directly on each tool schema it
registers, with an optional `toolUltra` field:

```js
ctx.tools.register({
  name: 'memory_note',
  description: 'Store a note.',
  parameters: { ... },
  toolUltra: { category: '/memory', risk: 'high', pinned: true },
})
```

Fields: `category` (name, with or without a leading `/`), `risk`
(`"low"` | `"medium"` | `"high"`; `"high"` marks the tool high risk for the
risk gate), `pinned` (always-on, not listed in the directory). Invalid values
are ignored with a log warning. Precedence: user settings (`metadata.json`,
`settings.json`) > `toolUltra` > `package.json` / `annotate()` > classifiers >
structural fallback.

### Tool packs

A package of tools can register itself as a pack. It is then listed in the panel's Packs tab, and it can be loaded in one call with `tools_load(["pack:<id>"])`:

```js
ctx.inject(['toolCatalog'], (c) => c.effect(() => c.toolCatalog.registerToolPack({
  id: 'web', title: 'Web reading', source: '@lvy-jsd/dsh-tool-ultra-pack-web',
  tools: ['web_read', 'web_links'],          // exact names or RegExps
  items: () => [],                           // optional per-part status for the panel
}))
```

### New categories

```js
ctx.effect(() => ctx.toolCatalog.defineCategory('games', 'Game servers and bots'))
```

### High-risk gates

A gate declares that a plugin confirms high-risk loads (normally by returning
`{ kind: 'ask' }` from `tools/pre-execute` for `tools_load`). **With no gate
registered, high-risk tools cannot be loaded at all** — they are skipped in
group loads and refused individually. That is deliberate: a deployment without
an approval path should not be able to arm them.

```js
ctx.effect(() => ctx.toolCatalog.registerRiskGate({ name: 'my-policy' }))
ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name !== 'tools_load' || !needsConfirmation(exec.arguments)) return next()
  return { kind: 'ask', reason: 'Loading a high-risk tool' }
}))
```

See [`dsh-tool-ultra-risk-gate`](../dsh-tool-ultra-risk-gate).

### Persistence

Loaded state lives in memory; a state provider makes it outlive the process.

```js
ctx.effect(() => ctx.toolCatalog.registerStateProvider({
  name: 'my-store',
  load: (agent) => readFromMyStore(agent.id),      // serialized state or null
  save: (agent, state) => writeToMyStore(agent.id, state),
}))
```

Providers are consulted in registration order (first non-null wins) and all
receive every save. `exportState(agent)` / `importState(agent, state)` are the
plain-JSON equivalents. See
[`dsh-tool-ultra-persist`](../dsh-tool-ultra-persist).

### Hooks

Plain Cordis events on the host context:

| Event | Kind | Payload |
|---|---|---|
| `tool-catalog/before-load` | serial; throw to veto | `{ agent, targets, names }` |
| `tool-catalog/after-load` | emit | `{ agent, targets, added }` |
| `tool-catalog/before-unload` | serial; throw to veto | `{ agent, targets }` |
| `tool-catalog/after-unload` | emit | `{ agent, targets, removed }` |
| `tool-catalog/before-rebuild` | emit | `{}` |
| `tool-catalog/after-rebuild` | emit | `{ catalog }` |
| `tool-catalog/state-changed` | emit | `{ agent, state }` (plain JSON, after every load/unload) |

```js
// A per-session quota: at most 60 visible tools.
ctx.on('tool-catalog/before-load', ({ agent, names }) => {
  const now = ctx.toolCatalog.allowFor(agent)?.length ?? 0
  if (now + names.length > 60) throw new Error('tool quota reached; unload something first')
})
```

### Visibility filters

A filter receives the agent and the computed allowlist and returns the names
to keep. It can only narrow; it can never add tools or hide the entry tools.

```js
// Keep GitHub write tools away from bot sessions.
ctx.effect(() => ctx.toolCatalog.registerVisibilityFilter({
  name: 'no-github-writes-for-bots',
  filter: (agent, names) => (agent.id.startsWith('bot-')
    ? names.filter((n) => !/^mcp__github__(create|delete|merge|push|update)/.test(n))
    : names),
}))
```

### Reading the catalog

`ctx.toolCatalog.get()` returns `{ tools, groups, categories }`;
`resolve(target)`, `stateOf(agent)`, `allowFor(agent)`, `deniedFor(agent)`
(allowed here but hidden by another layer), `isExempt(agent)`,
`packages()` (enabled plugin packages: `{ name, dir, manifest }`) and
`refresh()` are also available.

## Tests

See the repository root.

## License

Apache-2.0
