# dsh-tool-manager — Design v0.6

> Status: phase 1 implemented as a core + extension plugins (monorepo) and tested in throwaway `DSH_HOME` instances.
> Code: `~/dsh-plugins/dsh-tool-manager` (git monorepo: `packages/dsh-tool-manager`, `packages/dsh-tool-manager-classifier-rules`). Date: 2026-10-15.
> v0.5 adds §12 web panel and onboarding, §13 production-copy trial plan; licence MIT.
> v0.4 added §11 Extensibility ("everything is a plugin"), cross-directory search and exact-name loading.
> v0.1/v0.2 were Chinese drafts; this version replaces them and is English-only for open-sourcing.

## 0. Summary

Organise every tool registered in DSH as a three-level directory — **category → group → tool** — and let each agent load what it needs. The model normally sees only the always-on set plus three entry tools (`tools_ls`, `tools_load`, `tools_unload`). Loaded tools are **native** (full parameter schema, called directly), not proxied.

## 1. Host facts this design relies on (verified)

| Fact | Where | Consequence |
|---|---|---|
| `agent.ctx.tools.restrict({allow, deny})` narrows one agent's visible tools; returns a disposer | `dsh-tools` `restrict()` / `view()` | load/unload = swap one restriction |
| Visibility is recomputed by name on every view; all restrictions on a scope **intersect** | `view()`: `layers.every(admits)` | connector `deny` always wins over our allow |
| `restrict()` throws on names not currently registered | `restrict()` | allow must be intersected with registered names before install |
| `restrict()` emits `tools/change` **synchronously** | `ScopedLayers.effect` → `onChange` | install must be re-entrancy safe (see §9, bug found in testing) |
| Tool list is re-assembled **every step** from `wireSchemas(scope)` | `dsh-agent-loop` `preStep` → `systemPrompt.assemble` | a load is visible from the agent's next step |
| Tools are sent in **lexicographic order** unless `dsh-system-prompt` `toolOrder` is configured | `dsh-system-prompt` `orderTools()` | "append loaded tools at the end" is impossible without host config; see §6 |
| Subagent scope's parent is the preset generation, not the parent agent | `dsh-agent-preset-registry` `composeFrom`/`join` | every agent must be restricted separately |
| `agent/created` carries `{agent, source}` only; parent is found with `agents.isOwnedBy(child.id, p)`; session header has `parentSession` | `dsh-agent`, `dsh-subagent` `childSessionMeta()` | child bootstrap from the parent's handoff |
| `agent/created` is dispatched with `ctx.serial` and awaited before the first step | `dsh-agent` `announce()` | no window before the first request (confirmed by T14) |
| The registry stores no owning plugin per tool; `pluginInventory/list` lists plugins only | `ToolLayer`, `dsh-host-plugin-inventory` | groups are derived from names (+ optional source scan, phase 2) |
| A `tools/pre-execute` listener returning `{kind:"ask"}` routes through the host approval service; `never` policy or no answerer → fail closed | `dsh-tools` `serviceAsk()`, `dsh-user-approval` | high-risk confirmation needs no custom UI |

## 2. Directory

### 2.1 Paths

```
/                       categories
/<category>             groups
/<category>/<group>     tools
/<category>/<group>/<tool>
```

Targets may also be a bare group name, a full tool name, or a group-unique short tool name. Case-insensitive.

### 2.2 Group (the "name" level), first match wins

1. Override classifiers (priority ≥ 1000), e.g. the user's `groupRules` in `classifier-rules`.
2. Plugin declarations (`package.json` `dsh.toolCatalog`, runtime `annotate()`).
3. Ordinary classifiers, e.g. `classifier-rules` built-in rules for verb-named DSH tools (bots, groups, team, capability…).
4. Core structural fallback: `mcp__<server>__<tool>` → `<server>`; `mcp__<server>__<sub>__<tool>` → `<server>-<sub>`; shared non-verb `prefix_` (≥2 tools) → `<prefix>`; else `misc`.

Phase 2 adds a source scan (search each inventory plugin's `lib/**/*.js` for the tool-name literal; unique hit → that package) before step 4. Grouping never affects visibility — a misgrouped tool is only listed in the wrong place.

### 2.3 Category — fixed English list

`device`, `code`, `media`, `maps`, `browser`, `memory`, `collaboration`, `automation`, `connectors`, `search`, `system`, `uncategorized`.

Resolution order for a group's category (the core itself has no rules):

1. **User overrides** — `classifier-rules` config `categories.<name>.groups`, registered at priority 1000.
2. **Plugin declarations** — the tool's own plugin says where it belongs.
3. **Built-in defaults** — `classifier-rules` priority 100 (adb/phone/desktop → device, github/nix → code, …).
4. **Small-model classification (phase 2, `classifier-llm`)** — see §2.4.
5. `uncategorized` — always listed; never dropped. Without any classifier plugin, everything not self-declared lands here.

Measured on this host's ~190 tools with `classifier-rules` defaults: everything lands in a named category except `lingshu` (2) and `list_models` (1).

### 2.4 Small-model classification (phase 2)

- **When**: in the background, the first time a group is seen, and again only if the group's fingerprint changes. Never per call, never by the calling agent (keeps paths stable, costs nothing per session, same result for every session).
- **Unit**: a whole group (all its tool names + first-sentence descriptions) → exactly one category from the fixed list, or `uncategorized` if unsure.
- **Model**: see §2.5. No classifier plugin installed → feature off; groups stay `uncategorized` and remain fully usable.
- **Until it finishes**: the group is shown under `uncategorized/`.
- **Cache file** `$DSH_HOME/tool-manager/categories.cache.json`:

```json
{
  "version": 1,
  "groups": {
    "lingshu": {
      "category": "system",
      "fingerprint": "sha256:<hash of sorted 'name\\tdescription' lines>",
      "model": "deepseek/deepseek-flash",
      "classifiedAt": "2026-10-15T05:12:00Z"
    }
  }
}
```

User overrides always beat the cache; the cache is advisory and can be deleted at any time.

### 2.5 Model selection (user, 2026-10-15: "default DeepSeek, but freely selectable")

Every component that calls a model (`classifier-llm`, the T12 measurement script, any future one) takes the same config shape and never hard-codes a vendor:

```yaml
model:
  provider: deepseek-official   # any route DSH already has configured (dsh-llm / dsh-llm-pi-ai)
  model: deepseek-flash         # any model id served by that route
  reasoningEffort: off          # optional
```

- **Default**: DSH's DeepSeek route (`deepseek-official` / `deepseek-flash`). If that route is not configured on the host, fall back to the host's agent default model (`dsh-agent-default-model`); if neither resolves, the component stays off and says why.
- **Choices**: only routes and models the host `llm` service already lists — no API keys or endpoints in this plugin's config. Credentials stay in DSH's credential store or the route's `apiKeyEnv`.
- **Switching**: change the YAML, or (phase 2 ③) pick from a dropdown in the panel's Configuration view, which lists the host's models.

## 3. Visibility

### 3.1 Always-on (pinned) set — never listed in the directory

- DSH core: `bash read write edit str_replace_editor glob grep read_image ask_user_question ask_user exit_plan_mode workflow todo_write present skill plan web_fetch web_search job_list job_output job_kill create_goal get_goal update_goal`
- Delegation: `subagent subagent_fork list_subagent_models wait_agent interrupt_agent list_agents`
- Memory lookup: `recall` (decision 2), `memory_search memory_read` (dsh-auto-memory, same reason; write operations stay lazy)
- ds-bot: `show_view read_browser create_bot update_bot` (a Bot's prompt calls them directly; `ask_user` is in the DSH core line)
- Entry tools: `tools_ls tools_load tools_unload`
- Plus config `pinned`. Names the host lacks are ignored (survives renames).

### 3.2 Allowlist

```
allow(agent) = (pinned ∪ loaded ∪ tools of subscribed groups − excluded − highRisk-from-groups)
               ∩ names the host lets this agent restrict
```

Installed with `restrict({allow})`; new restriction first, old one released after, so there is never an unrestricted moment. Re-entrant calls (from the synchronous `tools/change`) only mark the agent dirty; the outer call loops.

### 3.3 Events

| Event | Action |
|---|---|
| `agent/created` | create state (restored from disk, else child bootstrap, else empty); install |
| `agent/disposed` | drop state and restriction |
| `tools/change` | invalidate catalog; recompute and reinstall for every live agent |
| mount | install for agents that already exist |
| plugin unload | release every restriction (fail open) |

### 3.4 Subagents (decision 5: A + B)

- **A**: a child starts from the pinned set plus what its parent loaded with `forSubagents: true` (groups and single tools). It does **not** copy the parent's whole loaded set.
- **B**: the entry tools are pinned, so a child can browse and load for itself.

### 3.5 Persistence (decision 4; implemented in phase 2 item ②)

The core keeps state in memory and exposes `registerStateProvider` (§11.3). The
`dsh-tool-manager-persist` plugin writes one JSON file per session id under
`$DSH_HOME/tool-manager/sessions/` on every change and hands it back when the
session is adopted again, so a DSH restart keeps a task's loaded tools. Groups
are stored by name, so a group that gains tools while DSH is down restores with
them included.

## 4. Entry tools

### `tools_ls(path = "/", query?)`

One line per entry. Root and category lines show tool count, loaded count and estimated schema tokens (JSON length / 4); group listings show `*` loaded, `!` high risk, short name, token estimate and the description's first sentence. Root listing ≈ 300–400 tokens; a 40-tool group ≈ 1.2k tokens. `query` searches tool name, group, category and full description across everything under `path` (the whole tree from `/`) and returns matches with their full paths — one step instead of walking the tree (borrowed from Claude Code's ToolSearch).

### `tools_load(targets[], forSubagents?)`

Targets: category, group, or one tool by path, exact full name (`mcp__github__get_me`) or unique short name — no tree walk needed when the name is known. Loading a category/group **subscribes** (future tools of that group are included). High-risk tools are never included in group/category loads. Returns the newly visible names and their token cost; usable from the next step.

Bare names such as `web` also try registered `pack:` → `cap:` → `device:` resolvers, stopping at the first non-empty expansion before normal directory lookup; paths and explicit prefixes keep their existing behavior and plugin ownership.

### `tools_unload(targets[] | "all")`

Same addressing. Unloading one tool inside a subscribed group excludes it. `all` returns to the pinned set. Pinned tools cannot be unloaded.

## 5. High-risk tools (phase 2; decision 3)

- High risk comes from the catalog declaration (`package.json` `risk: "high"` or `annotate()`) or from a list: the built-in `DEFAULT_HIGH_RISK` set plus config `highRisk`. Never part of group loads.
- Loading one individually goes through a `tools/pre-execute` listener that returns `{kind: "ask"}` → host approval pipeline. Sessions without an approval channel (policy `never`, no answerer) are refused automatically. Verified in the `gate` e2e profile.
- Config `allow` (`{ "<session id>": true | "*" | [tool, …] }`) skips the ask, so a bot session can still load e.g. `merge_pull_request` deliberately.
- **With no risk gate installed** (the `risk-gate` plugin absent), high-risk tools cannot be loaded at all: group loads skip them and individual loads are refused with a message. Implemented by the core, which only exposes the gate registration point.

## 6. Prompt cache

Loading cannot "append at the end": the host orders tools lexicographically. A load invalidates the cache from the first loaded name onward. Mitigations:

- Load whole groups once rather than tool by tool (stated in the tool description).
- Keep loads until session end or explicit unload; no TTL, no auto-unload.
- Optional host-side improvement: configure `dsh-system-prompt` `toolOrder` as `[<pinned…>, "<unlisted-tools>"]` so the pinned prefix is stable and only the tail changes. Not done by the plugin because `toolOrder` throws on unregistered names; to be evaluated with the user.
- Phase 2 test (T12): measure cache hit before/after a load on a real provider.
- **TODO (upstream DSH)**: find or add a hook so loaded tools sort *after* the pinned set (e.g. a `system-prompt/assemble` waterfall that reorders, or `toolOrder` accepting unknown names). Claude Code avoids the problem by appending fetched schemas to the conversation instead of changing the tool list; DSH has no equivalent today. Decide after T12 quantifies the loss; if worthwhile, open a PR against DSH.

## 7. Relation to existing mechanisms (decision 6)

- **Connector governance `deny`**: unchanged; intersects with our allowlist and is enforced at execution by its guard → always wins. Denied tools are marked `[denied]` in listings (0.3.0, §11.16).
- **`session-injection` (experimental, in `dsh-mcp-connector`)**: functionality absorbed, its code untouched. All connectors stay in "always inject" mode so only this plugin narrows. The planned start-up warning became a runtime one (0.3.0, §11.16): the connector exposes no service to read its records, so the plugin detects the effect instead — a loaded tool still hidden — and warns then. Reason: it is third-party code (forking it means maintaining a fork), two narrowing layers intersect and are hard to debug, and its per-call confirmation + 30-minute TTL conflict with this design.
- **`mcp_connector_tool_search/detail`**: kept; complementary.

## 8. Decisions (user, 2026-10-15)

1. Categories as proposed, now a fixed English list; `read_image` is pinned, not under `media/image`.
2. Pinned set adds `recall`; other engram tools stay in the directory.
3. High-risk: refused without an approval channel; per-session allow list in config.
4. Restore loaded tools after a DSH restart: yes.
5. Subagents: A + B.
6. `session-injection`: absorb functionality, don't modify its code; all connectors "always inject".
7. Plugin at `~/dsh-plugins/dsh-tool-manager`, JavaScript, git; everything in English (open-source intent).
8. Categorisation: user overrides > plugin declarations > rules / cached small-model classification > `uncategorized`.
9. "Everything is a plugin": a minimal core plus replaceable extension packages; others can modify and extend through the `toolCatalog` service (§11).
10. "Custom capabilities" means both: capability packs as tool bundles (`capability-bridge`) and user-defined behaviour through extension points and config (§11).

## 9. Phase 1 test results (throwaway `DSH_HOME`, headless profile, scripted fake model)

Harness: `test/e2e.mjs` boots the shipped `headless` profile in a temp `DSH_HOME` twice — **core** (core only) and **rules** (core + `classifier-rules` with a user override) — with a test kit plugin and a fake OpenAI-compatible model that logs the exact tool list and tool results of every request. The test kit provides fake `mcp__fake__*` tools, `testkit_reconnect` (unregister + re-register + one new tool), `adb_fake_*` tools declared in its `package.json` (`category: code`, `adb_fake_two` high risk), `phone_fake_*` tools, a `before-load` hook vetoing the target `veto-me`, and a visibility filter hiding `phone_fake_swipe`. The real profile is never touched. Unit tests (`node --test test/unit/*.test.mjs`, 10 tests) cover catalog resolution and registries.

| Profile | # | Check | Result |
|---|---|---|---|
| core | T14a | Fresh session, first request: unloaded tools absent | PASS |
| core | — | No classifier: root shows only `uncategorized` + the self-declared `code` | PASS |
| core | — | No classifier: no rule-based categories | PASS |
| core | — | Group load visible from the next step | PASS |
| core | T4 | Reconnect with group loaded: same names return, new tool joins | PASS |
| core | — | Unload group → hidden | PASS |
| core | T4 | Reconnect with nothing loaded: old and new names stay hidden | PASS |
| core | — | Load by exact tool name | PASS |
| core | T4 | Reconnect with single tool loaded: it survives, siblings hidden | PASS |
| core | T7 | Child without handoff: pinned only | PASS |
| core | — | Parent unaffected by child | PASS |
| core | T7 | Child after `forSubagents` handoff: gets the group | PASS |
| core | — | No classifier: `fake/`, `phone/` under `uncategorized` | PASS |
| core | — | Hook: `before-load` listener vetoes a load | PASS |
| core | T14b | Resumed session: restored loads, nothing else exposed | PASS |
| rules | — | User override (priority 1000) places `fake` under `maps` | PASS |
| rules | — | Default rules place `phone` under `device` | PASS |
| rules | — | `package.json` declaration beats the default `adb → device` rule | PASS |
| rules | — | Declared risk marks `adb_fake_two` high risk | PASS |
| rules | — | Search from `/` finds `/maps/fake/ping` across directories | PASS |
| rules | — | Group load skips the declared high-risk tool | PASS |
| rules | — | Visibility filter narrows (`phone_fake_swipe` hidden) | PASS |

22/22 end-to-end and 10/10 unit tests pass.

Bug found and fixed in phase 1: `restrict()` re-enters `install()` via the synchronous `tools/change`; the nested call stacked a second restriction whose disposer was lost, permanently hiding later loads. Fixed with a per-agent busy/dirty loop (§3.2).

Not yet covered: the real web profile (many plugins, live MCP connectors), PTC mode, the startup window when the plugin loads after agents already started (mount-time sync handles it; headless does not exercise it). **All three covered since** — the production-profile copy in §13 and a real box profile in §11.16 (real profile), the `ptc` e2e run and the start-up unit test (§11.16).

**Superseded in phase 2 item ②**: the suite now runs five profiles (`core`, `rules`, `preset`, `persist`, `gate`) with 25 end-to-end assertions and 26 unit tests; T14b moved to the `persist` profile now that persistence is a plugin. See §11.8. The production-copy trial and T12 are in §13.

## 10. Phase 2 backlog

Extension packages (each its own package in the monorepo, each optional):

Done in phase 2 item ② (2026-10-15):

- `dsh-tool-manager-risk-gate` — approval for high-risk loads via `tools/pre-execute` `ask` + per-session allow list (§5, §11.8).
- `dsh-tool-manager-persist` — per-session persistence moved out of the core; the core now exposes a `registerStateProvider` extension point and `exportState`/`importState` instead (§11.8).

Done in phase 2 item ③ (2026-10-15):

- `dsh-tool-manager-panel` — web panel with the Directory, Sessions and Configuration views (§12, §11.9). The "Extensions" view is folded into Configuration; onboarding docs are in the package READMEs.

Done in phase 2 item ④ (2026-10-15):

- `dsh-tool-manager-classifier-llm` — cached small-model classification (§2.4, §11.10).

Done in phase 2 item ⑤ (2026-10-15):

- `dsh-tool-manager-capability-bridge` — capability packs as tool bundles (§11.6, §11.11).

Done in phase 2 item ⑥ (2026-10-15):

- Onboarding (§12.5): root README 3-step quick start, `create-tool-manager-plugin` scaffolder, `examples/example-classifier` and `examples/example-filter`, and an "Extending" section in the root README.

Done after installation (2026-10-15):

- `dsh-tool-manager-attribution-scan` — tool → plugin package from source (§2.2, §11.12).
- Panel: an exempt session shows `exempt` instead of "0 visible" (§11.12).

Core follow-ups: `[denied]` marks and per-session-mode connector warning (§7) — done in 0.3.0 (§11.16); upstream DSH tool-ordering TODO (§6) — deprioritised by the T12 measurement (§13).

Licence: **MIT** (user, 2026-10-15).

Updated phase 2 order (user, 2026-10-15): ① production-copy trial + T12 cache measurement (§13) → ② `risk-gate` + `persist` → ③ `panel` + onboarding (§12) → ④ `classifier-llm` → ⑤ `capability-bridge` → ⑥ install on the daily DSH.

## 11. Extensibility — "everything is a plugin"

### 11.1 Principles

1. **The core does the minimum**: directory, entry tools, per-agent allowlist, persistence hooks, and the `toolCatalog` service. It ships no placement rules — without extensions every group is `uncategorized` (verified, §9).
2. **Everything else is a replaceable plugin** using only the public service. The bundled `classifier-rules` package is written exactly as a third party would write it, which is what proves the extension points work.
3. **Extensions can narrow, never widen**: classifiers and declarations only move tools in the directory; visibility filters only remove names; nothing can bypass connector `deny` or the host's restrictions.
4. **Registrations are effects**: every `register*`/`annotate`/`defineCategory` returns a disposer; extensions call them inside `ctx.effect` so unloading the extension undoes them.

### 11.2 Package layout

| Package | Status | Role |
|---|---|---|
| `dsh-tool-manager` | phase 1 | core + `toolCatalog` service |
| `dsh-tool-manager-classifier-rules` | phase 1 | built-in rules (priority 100) + user overrides (priority 1000) |
| `dsh-tool-manager-classifier-llm` | phase 2 ④ | cached small-model classification |
| `dsh-tool-manager-risk-gate` | phase 2 ② | approval for high-risk loads |
| `dsh-tool-manager-persist` | phase 2 ② | per-session persistence (moved out of core) |
| `dsh-tool-manager-attribution-scan` | done | tool → plugin package from source (§11.12) |
| `dsh-tool-manager-capability-bridge` | phase 2 ⑤ | capability packs as tool bundles |
| `dsh-tool-manager-panel` | phase 2 ③ | web panel (§12) |
| `create-tool-manager-plugin` | phase 2 ⑥ | scaffolder for extension plugins (§12.5) |

### 11.3 The `toolCatalog` service (implemented)

| Member | Purpose |
|---|---|
| `registerClassifier({ name, priority, group?(tool), categorize?(group) })` | Place tools into groups and groups into categories. `priority ≥ 1000` = override tier (beats declarations). Return `undefined` to pass; throwing is skipped. Synchronous; async classifiers (LLM) answer from their cache and call `refresh()` when new results land. |
| `annotate(match, { group?, category?, risk?, summary? })` | Runtime metadata; `match` is an exact name or a regex string. Beats `package.json` declarations. |
| `defineCategory(name, description)` | Extend the category vocabulary. |
| `registerVisibilityFilter({ name, filter(agent, names) })` | Extra narrowing per agent (per bot, per preset, quotas…). Cannot add names or hide entry tools. |
| `registerTargetResolver({ name, prefix, resolve(target) })` | Own a target prefix in `tools_load` / `tools_ls` / `tools_unload`. `resolve` returns one or more ordinary targets to resolve instead, or `undefined` to pass. How `capability-bridge` adds `cap:<name>` without the core knowing what a capability is. |
| `registerRiskGate({ name })` | Declare that a plugin confirms high-risk loads. With no gate registered, high-risk tools cannot be loaded at all (they are skipped in group loads and refused individually) — so a deployment that never installs `risk-gate` simply cannot arm them. Returns a disposer. |
| `registerStateProvider({ name, load(agent), save(agent, state) })` | Let loaded state outlive the process. `load` returns a serialized state or null; `save` receives plain JSON on every change. Providers are consulted in registration order (first non-null wins) and all receive saves. A provider that mounts late still restores agents nothing has been loaded into yet. Returns a disposer. |
| `exportState(agent)`, `importState(agent, state)` | Plain-JSON read/write of one agent's loaded state, for plugins that keep state elsewhere (session log, database). |
| `load(agent, targets, {forSubagents})`, `unload(agent, targets)` | The entry tools' logic as service methods, so a UI goes through exactly the same path (hooks, vetoes, risk gates, persistence). Returns the model-facing text. |
| `agents()` | Live agents as `{ agent, id, parentId }`, subagents carrying their parent. |
| `config()` | Effective configuration (always-on list, config additions, high-risk list) for display. |
| `extensions()` | Registered extension points: classifiers with priorities, filters, annotations, categories, risk gates, state providers. |
| `find(query, path)` | Structured cross-tree search: the same matching rules as `tools_ls(query)`, returned as data. |
| `wireTokens(agent)` | Schema tokens actually sent for an agent (its visible set), for cost display. |
| `get()`, `resolve(target, agent)`, `stateOf(agent)`, `allowFor(agent)`, `isExempt(agent)`, `packages()`, `refresh()` | Read the catalog and per-agent state; whether an agent's route is exempt; the enabled plugin packages (`{ name, dir, manifest }`); force a rebuild (also re-reads `package.json` declarations). |
| `tool-catalog/state-changed` event | Emitted after every load/unload with `{ agent, state }` (plain JSON). |

### 11.4 Plugin self-declaration (implemented)

`package.json` → `dsh.toolCatalog`:

```json
{ "dsh": { "toolCatalog": {
  "match": "^adb_", "group": "adb", "category": "device",
  "tools": { "adb_install": { "risk": "high", "summary": "Install an APK." } }
} } }
```

Read from every package the host loader knows (`ctx.loader.entries()`). Exact-name entries beat `match`; runtime `annotate()` beats `package.json`; user overrides beat both. Self-declaration is the most accurate source and also answers "which plugin owns this tool" without scanning.

### 11.5 Hooks (implemented, plain Cordis events)

| Event | Kind | Payload |
|---|---|---|
| `tool-catalog/before-load` | serial; throw to veto | `{ agent, targets, names }` |
| `tool-catalog/after-load` | emit | `{ agent, targets, added }` |
| `tool-catalog/before-unload` | serial; throw to veto | `{ agent, targets }` |
| `tool-catalog/after-unload` | emit | `{ agent, targets, removed }` |
| `tool-catalog/before-rebuild` | emit | `{}` |
| `tool-catalog/after-rebuild` | emit | `{ catalog }` |

Uses: audit logs, quotas, usage statistics, `risk-gate`, `capability-bridge`.

### 11.6 `capability-bridge` (implemented, phase 2 item ⑤ — see §11.11)

DSH capability packs become tool bundles: `tools_load(["cap:android-debug"])`.

**Open question for the next version**: the shipped capability store lives in
`ds-bot` (`attach_capability` / `detach_capability`), not in the core, and no
core service publishes packs. So packs currently come from this plugin's config
or from another plugin calling `registerPack` through the `toolCapabilityPacks`
service. Auto-load-on-attach (§11.6 original design) needs the host event that
`ds-bot` uses; that is a follow-up once the store's shape is confirmed.

### 11.7 User-configurable settings

| Where | Key | Meaning | Default |
|---|---|---|---|
| core | `pinned` | extra always-on tools | `[]` |
| core | `unpin` | built-in always-on tools to move into the directory | `[]` |
| core | `highRisk` | tools excluded from group loads | `[]` |
| persist | `enabled` | register the state provider | `true` |
| persist | `dir` | where per-session state files live | `$DSH_HOME/tool-manager/sessions` |
| persist | `write` | `false` = restore only, never write | `true` |
| classifier-rules | `defaults` | use built-in rules | `true` |
| classifier-rules | `groupRules` | regex → group (override tier) | `[]` |
| classifier-rules | `categories` | `{ cat: { description?, groups } }` (override tier; can add categories) | `{}` |
| classifier-llm | `model` | `{ provider, model }` the classifier uses; omitted = groups stay uncategorized | off |
| classifier-llm | `cacheFile` | where group → category answers are cached | `$DSH_HOME/tool-manager/classifier-cache.json` |
| classifier-llm | `maxTokens`, `batchSize`, `priority` | one-word answers; groups per refresh; classifier tier | `16`, `5`, `50` |
| risk-gate | `enabled` | install the gate | `true` |
| risk-gate | `highRisk` | extra tools treated as high risk | `[]` |
| risk-gate | `defaultHighRisk` | include the built-in list (GitHub write tools…) | `true` |
| risk-gate | `allow` | `{ <session id>: true \| "*" \| [tool, …] }` — sessions that skip the prompt | `{}` |
| panel | `enabled` | mount the API and event routes | `true` |
| core | `settingsFile` | where the panel's edited lists are written | `$DSH_HOME/tool-manager/settings.json` |
| core | `metadataFile` | where the panel's per-tool metadata edits are written | `$DSH_HOME/tool-manager/metadata.json` |
| core | `exemptFile` | route/session exemptions; **replaces** `exemptProviders` when present | `$DSH_HOME/tool-manager/exempt.json` |
| capability-bridge | `prefix` | target prefix marking a pack | `"cap:"` |
| capability-bridge | `packs` | `{ <name>: [targets] }` — what each pack expands to | `{}` |
| capability-bridge | `listInDirectory` | add a `capabilities` category | `true` |
| any plugin | `package.json` `dsh.toolCatalog` | self-declared group / category / risk / summary | — |

Every extension point has a minimal example plugin in the core README.

### 11.8 Phase 2 item ② — `risk-gate` and `persist` (implemented, 2026-10-15)

**`risk-gate`.** Loading a tool runs nothing, so ordinary loads stay prompt-free;
high-risk tools are confirmed *at load time* so the model cannot arm one and call
it a step later.

- It registers a risk gate, which is the signal that re-enables high-risk loading
  (no gate → the core refuses them outright).
- On `tools/pre-execute` for `tools_load` it returns `{ kind: 'ask' }` when the
  load would include a high-risk tool. DSH routes that to its approval channel; a
  session with no channel is denied by the host — the safe default, verified in
  the `gate` e2e profile.
- High-risk tools are still only loadable one at a time (group loads skip them),
  so each confirmation covers exactly one dangerous tool.
- `allow` gives unattended sessions a way through: `{ "<session id>": true }` or a
  list of tool names. This is the "per-session allowlist" decision from §5.
- Risk comes from the catalog declaration first (package.json `risk: "high"` or
  `annotate()`), then the plugin's own list (`DEFAULT_HIGH_RISK` +
  config `highRisk`).

**`persist`.** The core no longer writes files. It exposes `registerStateProvider`
and emits `tool-catalog/state-changed`; `persist` subscribes and writes one JSON
file per session id under `<DSH_HOME>/tool-manager/sessions/`. A session with
nothing loaded gets no file, and unloading everything removes it. Groups are
stored by name, so a group that gains tools while DSH is down restores with them.

Two details worth keeping: a state provider that mounts after the first sync
still gets one chance to restore (agents that already loaded something are never
overwritten — the controller tracks which agents the user touched), and `write:
false` makes a session restore-only.

**Verification** (throwaway `DSH_HOME`, headless profile, scripted fake model):
26 unit tests (catalog, registries, persist file semantics, gate decisions and
allowlist precedence) and 25 end-to-end assertions across five profiles
(`core`, `rules`, `preset`, `persist`, `gate`) all pass — including T14b (state
survives a restart), a denied high-risk load, and "ordinary tools still load
without a prompt".

### 11.9 Phase 2 item ③ — the web panel (implemented, 2026-10-15)

`dsh-tool-manager-panel` is a separate optional package, and the core needed
only read-only additions to support it (§11.3): `load`/`unload` as service
methods, `agents()`, `config()`, `extensions()`, `find()`, `wireTokens()`.
Nothing in the core knows the panel exists.

- **Server half** mounts `POST /tool-manager/api` (method whitelist) and
  `GET /tool-manager/events` (SSE) behind the same loopback + same-origin fence
  `dsh-mcp-connector` uses. (v1 also served a static page at
  `/tool-manager/ui/`; removed in §11.13.)
- **Browser half** is a `window.__ModuleLoader__.load({...})` registration,
  written in TypeScript and compiled by `tsc` into a classic script (DSH
  concatenates client bundles, so the output carries no `export` and no
  `"use strict"`) — no bundler. v1 put a `sidebar.panellist` row and an iframe in
  the main sidebar; since §11.13 it is a native `settings.section`.
- **Views**: Directory (tree, per-node counts and tokens, search, load),
  Sessions (per-agent loaded state, visible count, real schema tokens, load and
  unload), Configuration (effective lists plus the extension-point inventory).
- Loading from the panel calls `toolCatalog.load`, so `before-load` hooks,
  vetoes apply. The risk gate's approval prompt does not (it guards the
  model's `tools_load`; a panel click is the user's consent), and with no gate
  installed high-risk loads are still refused.

Two host facts found while building it, worth keeping:

1. `wctx.webRuntime` **throws** when a context injected only `webServer`
   ("cannot get property without inject"); read optional services through
   `ctx.get(name)` instead.
2. `webServer.register` takes `{ kind: 'prefix', path, handler }` and the host
   logs a handler exception as a bare **400** with no body, so a failing route
   looks like a client error until you read the host log.

**Verification**: the routes are exercised over a real HTTP socket in the unit
suite (ui, api, method error, traversal, SSE), and the panel was opened in a
throwaway web profile against real plugins — 28 tools across 12 categories, tree
drill-down, cross-tree search, the Configuration view, and the sidebar entry all
render. Two bugs were found and fixed that way: `append(null)` rendering the
literal text "null" in every row, and `search` returning a text blob (spread
character-by-character by JSON) instead of structured results.

### 11.10 Phase 2 item ④ — `classifier-llm` (implemented, 2026-10-15)

Places tool groups into categories with a small model, without ever classifying
on the hot path — the directory must stay stable, and a moving group invalidates
paths the model memorised and costs another prompt-cache miss.

- `categorize(group)` is synchronous and answers from a cache file; a miss is
  queued and the group stays `uncategorized` meanwhile.
- The queue is pumped **after** `tool-catalog/after-rebuild`, so a rebuild never
  waits on the network; new answers call `toolCatalog.refresh()`.
- One request **per group**, not per call. A host with 40 groups makes ~40 small
  requests in total, ever.
- Cache key = `sha1(group name + sorted("tool:sha1(description)"))[:16]`: a
  rewritten description or a tool joining the group re-classifies it; reordering
  never does. A corrupt cache file is an empty cache, never a crash.
- A failed or unusable answer is remembered for the process, so a provider
  outage cannot become a retry loop.
- Priority 50 (ordinary tier): plugin declarations and user rules still win.
- No `model` configured → the classifier registers and does nothing. The plugin
  is optional and so is the model; no keys are stored.

**Host fact found here**: the LLM stream protocol carries text as
`text-delta` chunks (`{ type: 'text-delta', index, text }`), not `type: 'text'`.
Reading the wrong member yields an empty answer that looks like a model problem.
The plugin therefore consumes the stream directly and needs no import from the
harness — the `llm` service is enough.

**Verification**: 22 unit tests (key stability, cache file round-trip and
corruption, prompt and answer parsing, one-request-per-group, failure memory,
bounded queue, plugin wiring) and an e2e `llm` profile where the scripted model
answers a classification prompt and the resulting category appears in the
directory on the next rebuild.

### 11.11 Phase 2 item ⑤ — `capability-bridge` (implemented, 2026-10-15)

Adds the `cap:<name>` target form through a new core extension point,
`registerTargetResolver({ name, prefix, resolve })` — the core never learns what
a capability is.

- A resolver is consulted before the built-in rules; `undefined` means "not
  mine" (so an unknown pack is an ordinary miss) and `[]` means "mine but empty".
- One target in a pack → the alias **is** that node. Several → one synthetic
  category holding exactly those tools.
- The alias carries its exact tool list (`aliasTools`) and `tools_load` adds
  those tools individually instead of subscribing to their group names.
  **Second bug found while testing**: subscribing by name meant a pack naming
  two tools also loaded every sibling in their groups (`adb_logcat`,
  `merge_pull_request`) — a silent widening of exactly the kind the allowlist
  exists to prevent. The regression test was verified to fail without the fix.
- **Bug found and fixed while testing**: the synthetic node first reused the
  catalog's own group objects, so a pack naming one tool from a shared group
  (`misc`) would have loaded every sibling tool. It now regroups copies holding
  only the named tools.
- High-risk tools inside a pack keep their own name after expansion, so the risk
  gate still confirms them.
- Packs come from config (`packs: { name: [targets] }`) or from another plugin
  via the `toolCapabilityPacks` service (`registerPack` returns a disposer and
  refreshes the catalog).

**Verification**: 15 unit tests (registration, configurable prefix, unknown-pack
fall-through, single/multi-target expansion, empty packs, runtime registration
and disposal, the exposed service) and an e2e `cap` profile where
`tools_load(["cap:static"])` loads exactly the pack's tools and an unknown pack
reports a normal miss.

### 11.12 `attribution-scan` and the exempt panel marker (implemented, 2026-10-15)

`dsh-tool-manager-attribution-scan` is an ordinary classifier at priority 10:
below `classifier-rules` (100) and plugin declarations, above the core's
structural fallback.

- After the first catalog build it reads, once and in the background, the
  `lib/`, `src/` and `dist/` JavaScript of every enabled plugin package (from
  the new core method `packages()`; never `node_modules` or tests; the tool
  manager's own extensions are skipped). Startup never waits on disk; the
  catalog refreshes when the index is ready.
- A tool goes to a package when exactly one package **defines** it
  (`name: '<tool>'`); failing that, when exactly one package **mentions** it.
  Ambiguous and unknown names pass. `mcp__…` names are skipped (built at
  runtime; the core groups them by server).
- Group name = package name without scope and without `stripPrefix` (default
  `dsh-`): `dsh-engram` → `engram`. A category declared in `package.json`
  still applies to the attributed group.
- Dry run over this host's 487 packages (read-only): ~1 s; e.g. `agent_*` →
  `agent-link`, `job_*` → `tool-jobs`, `phone_*` → `phone-control`,
  `spawn_teammate` / `team_task_*` → `experimental-tool-agent-team`;
  `bash`, `subagent`, `web_search` and similar pass (several packages define them).

**Regression found after install, fixed**: the scan renamed `phone`, `desktop`
and `mcp_connector` groups after their packages (`phone-control`,
`desktop-eyes`, `mcp-connector`); the category rules only knew the old names,
so production `/uncategorized` grew from 14 to 60 tools. Fix:

- Core: a group no classifier categorizes **inherits** the category of the
  structural groups its tools came from (the one the shared-prefix fallback
  would have used), weighted by tool count. A rule for the new name still wins.
- `classifier-rules` defaults also map the three new names.
- `test/uncategorized-check.mjs` builds the catalog from a real tool list with
  and without the scan and fails if the scan leaves more tools uncategorized
  (production list: 14 vs 14; 14 vs 60 before the fix). An e2e `attr-rules`
  profile with a declaration-free device package checks the same in a host;
  both were verified to fail without the fix.

Panel: `sessions` now reports `exempt` (from the new core method
`isExempt(agent)`); an exempt session shows an `exempt` chip and a note instead
of "0 visible", because an unnarrowed route has no allowlist to count.

**Verification**: 6 unit tests for the scan (definition beats mention,
mention-only, ambiguous / unknown / MCP pass, skipped directories and packages,
group naming, classifier before/after the index), 1 panel unit test for the
exempt flag, and an e2e `attr` profile: before the scan the testkit's phone
tools sit in the prefix group `phone/`; after it they are under
`/code/tm-testkit/` (declared category kept) while MCP tools stay in `fake/`.
The fake model gained an optional per-step `delayMs` to wait for background work.

### 11.13 Panel moved into Settings, native and bilingual (implemented, 2026-10-15)

Requested by the user via the manager: entry in the **Settings** sidebar named
"工具管理", theme consistent with DSH, interface in English and Chinese.

- The browser half registers one `settings.section` (`id: tool-manager`,
  `order: 40`, `locale: tool-manager.panel`) and renders the three views
  natively with React. The main-sidebar row, the iframe and the static
  `/tool-manager/ui/` page are gone, so there is one UI to maintain.
- Styling uses only `--dsw-alias-*` / `--dsw-radius-*` host variables (the same
  ones the built-in settings pages use), so the panel follows the active theme.
  `dsh-theme-firefly` overrides those variables, so it applies as well.
- Copy: `en` and `zh` dictionaries registered with the host `locale` service;
  switching the DSH language re-renders the section. Category names and the
  built-in category descriptions are translated; group and tool names are
  identifiers and stay as they are. Load/unload confirmations are localized;
  the core's model-facing text (English) is kept as the tooltip.
- Client inject list now includes `dsh-client-locale` and
  `dsh-client-ui-settings` so the section registers after the settings shell.

Host facts worth keeping: `dsh-theme-firefly` is **dark-only** — it forces
`color-scheme: dark !important` and a MutationObserver re-adds
`data-ds-dark-theme`, so choosing "Light" under firefly changes nothing. The
light check was therefore done with the default DSH theme.

**Verification** (throwaway web profile, fake model, real browser): Settings →
工具管理 renders; Directory / Sessions / Configuration show real data; loading
a category from the panel reached the live session (visible 27 → 33, tokens
sent 225) with a localized confirmation; screenshots taken for firefly dark
(zh), default light (zh), default light (en) and default dark (en). Unit tests
cover the API and event routes over a real socket and that `/tool-manager/ui/`
is gone (404).

### 11.14 `dsh-tool-manager-dsbot-entry` (implemented, 2026-10-15)

The production UI runs in the ds-bot layout, which hides DSH's Settings button;
the panel's Settings section is reachable only through Bot settings → Harness
settings. ds-bot's settings dialog and account menu are hard-coded in its bundle
with no extension point, so changing ds-bot would be overwritten by its next
upgrade. Design (manager): a separate browser-only plugin that adds the entry
from the outside.

- A component in the host `shell.overlay` slot watches the document with a
  `MutationObserver`; on a `.bt-settings[role=dialog]` with `nav.bt-settings-nav`
  and `.bt-settings-main` it inserts one `.bt-settings-item` row above
  "Harness settings" and one host element over the page area. Unexpected DOM →
  nothing happens. Only nodes it created are ever touched or removed.
- The panel module now exports `ToolManagerSection` and `NS`; the entry renders
  that component through `createPortal` (no second React root) with the panel's
  dictionaries via the slot's `locale`, so language switches re-render it.
- Theme: inside the host, `--dsw-alias-*` are mapped to ds-bot's `--bt-*`
  variables. While open, ds-bot's glide thumb and current-row highlight are
  muted with a data attribute on the dialog; any ds-bot row closes the panel.

**Verification**: throwaway web profile with ds-bot + firefly + fake model, real
browser: row inserted once above "Harness settings"; panel opens with data;
clicking "Bots" closes it and ds-bot shows its page; closing and reopening the
dialog leaves no leftovers and no duplicate row; switching DSH to Chinese renames
the row and the panel. Screenshots cropped to the dialog only. Unit tests load
both browser modules under a stub module loader (export present, one overlay
registered with the panel namespace, silent when the panel is absent).

### 11.15 Panel interactions: metadata editing and the exemption file (implemented, 2026-10-17)

Requested by the user via the manager: browse and edit a tool's API metadata,
edit the settings lists, and let a file replace the config `exemptProviders`.

- **Editable settings (item 1).** The Configuration view is no longer read-only:
  the always-on list and the high-risk list take additions and removals and save
  through `updateConfig`, which writes `settings.json` and rebuilds the catalog.
  These are exactly the lists `cordis.patch.yml` cannot be edited for from a
  browser.
- **Tool metadata (item 2).** A new `Metadata` tab: pick a tool (or open one from
  the Directory), see three layers — the package/classifier declaration, the
  panel's own edit, and what the model actually receives — and edit group,
  category, risk and summary. `metadata.json` holds
  `{ "<tool>": { group?, category?, risk?, summary? } }`; an edit is the whole
  entry, so a blank field falls back to the declaration. The panel edits only
  what the core already exposes: **not** `parameters` or `description`. DSH has
  no public interception point for the schema sent to the model (`dsh-tools`
  exposes the execution-time `tools/pre-execute`, `tools/execute` and
  `tools/post-execute` hooks plus the observe-only `tools/result` emit event;
  `view`/`schemaOf` are host-private), so
  touching it would break across versions.
- **Exemption file (item 4).** `<DSH_HOME>/tool-manager/exempt.json` replaces
  `exemptProviders` the same way `settings.json` does: present → file wins as a
  whole; absent → the config list applies. Shape
  `{ "providers": [...], "sessions": [...] }`. `sessions` exempts a single
  session by id for its remaining lifetime, toggled by a button in the Sessions
  view without de-exempting the route. Reading the agent's session id falls back
  to the agent id, so an entry can be removed by hand either way.

**Verification**: 11 unit tests for the exemption store (file-vs-config
precedence, corrupt file warns instead of restoring config, `reasonFor` sources,
first edit preserves the visible list, reload, atomic write, `DSH_HOME`
default), 6 panel API tests (report, set, missing id → 400, reload, whitelist)
plus the metadata tests from item 2; `tsc -b` clean, 172 unit tests and the
full e2e suite pass.

### 11.16 Release 0.3.0 (2026-10-22)

- **DSH 0.2.1.** The plugin code needed no change. The e2e harness did: from 0.2.1 the `subagent` tool never waits (it returns `started subagent <id>` and the child runs beside its parent), so the scripted fake model handed the parent's next step to the child. `fake-llm` now keeps one step queue per conversation (picked by a marker in its first user message) and can skip a step whose trigger does not match (`skipUnless`), so one script covers 0.2.0 and 0.2.1. The suite passes on both.
- **`[denied]` marks.** `deniedFor(agent)` = names this plugin allows (pinned or loaded) that the host's final view (`tools.view(agent).visible`) still lacks — a connector governance deny, its per-session injection, or any other plugin's `restrict()`. `tools_ls` marks them `[denied]`; a tool node says "denied by another plugin … not callable"; `tools_load` lists only the callable additions and names the denied ones. Without `view().visible` nothing is reported. Unloaded tools are not marked: our own restriction hides them too, and the host offers no public way to evaluate one layer without another. e2e: `testkit_deny` installs a connector-style `restrict({ deny })`.
- **Per-session injection warning.** The connector keeps its records in its own storage and exposes no service, so a start-up check would depend on its internals. Its effect is the same as a deny, so the first time a loaded tool turns out hidden the core logs one warning per tool naming both causes (governance rules, per-session injection).
- **PTC mode.** Found by the new `ptc` e2e run (`DSH_TOOLS_MODE=ptc`): the host's global schema list contains the reserved `run_code` transport, the core catalogued it as an ordinary hidden tool, and the hidden-call rescue then refused every `run_code` call ("not available in this session") — PTC mode was unusable with the plugin installed. `run_code` is now `HOST_RESERVED`: never catalogued, listed, loaded or restricted (the host refuses to restrict it anyway). Verified: only `run_code` is offered, the SDK section names no unloaded tool, `tools_ls`/`tools_load` work from inside a program, and a loaded tool is callable from the next program.
- **Start-up window.** Unit test: agents that exist before mount get exactly one restriction (pinned only) even though the fake host emits `tools/change` synchronously from `restrict()`; a later load replaces it; an agent created after mount is restricted; unmount releases all.
- **Default rules for MCP server names** (`classifier-rules` 0.2.0): `search`, `searxng`, `web-search`, `brave-search`, `tavily`, `exa` → `search`; `email`, `mail`, `gmail`, `imap`, `outlook` → `mail` (a category the plugin defines itself, so it works with any core); `playwright`, `puppeteer`, `chrome-devtools` → `browser`. Found on a real deployment: a SearXNG server named `search` sat in `/uncategorized`, so the model's first guess, `/search`, loaded only the X search tool.
- **Real profile.** Installed from npm on a home server's `box` profile (local 27B model, 10 plugins, live browser/email/search MCP servers). Same prompt, first request: 20.9k → 6.9k prompt tokens with the email server down; its 52 tools (~10.8k tok) are now behind `/mail` as well. The model found tools through `tools_ls` with a query and loaded single tools by path.
- **Versions.** core 0.3.0, `panel` 0.2.0 (its settings-page editing needs core ≥ 0.3.0), `classifier-rules` 0.2.0; the other packages are unchanged.

## 12. Web panel and onboarding (design; implementation is phase 2 item ③)

### 12.1 Package and mechanism

`dsh-tool-manager-panel` — a separate, optional plugin (`inject: ['toolCatalog']`, optional `['webServer', 'webRuntime']`), following the same pattern as `dsh-mcp-connector`'s market UI:

- **Server half**: `ctx.webServer.register(...)` mounts, under the same origin, `GET /tool-manager/ui/*` (static single-page app), `POST /tool-manager/api` (JSON-RPC with a method whitelist), `GET /tool-manager/events` (SSE: catalog rebuilt, agent loaded/unloaded — driven by the core's hooks). All routes pass the host's browser trust fence (loopback + same origin). No web services present (headless) → the plugin mounts nothing and stays harmless.
- **Client half**: `package.json` `dsh.client.inject` adds an entry in the DSH web settings/sidebar that opens the panel. Exact client slot to be confirmed against `dsh-client-ui-settings-plugins` / `dsh-client-ui-layout` before implementation.

### 12.2 Views

| View | Shows | Actions |
|---|---|---|
| **Directory** | category → group → tool tree; per node: tool count, loaded-in-N-sessions, schema tokens; per tool: summary, risk, source (which classifier or declaration placed it) | search across the tree; open a tool's full schema |
| **Sessions** | live agents (and subagents under their parent); per agent: loaded groups/tools, handoff set, current visible tool count and **schema tokens actually sent** (pinned + loaded) vs. "everything" baseline | load / unload for that agent (goes through the same hooks, so `risk-gate` still applies) |
| **Configuration** | pinned list, `unpin`, high-risk list, and (v1) the extension inventory: classifiers with priorities, visibility filters, risk gates, state providers, categories | v1 read-only; a later version edits through the host config editor with a diff preview |

### 12.3 Needs from the core (delivered in item ③)

All four landed as read-only service additions (§11.3, implemented): `load` /
`unload`, `agents()`, `find()` and `wireTokens(agent)`.

Still open for a later version: placement provenance on each catalog entry
(`placedBy: 'rules:user' | 'declaration:<pkg>' | …`), used by the Directory view
to show *why* a tool sits where it does.

v1 ships Directory, Sessions and Configuration (with the extension inventory
folded in); a separate Extensions tab and config editing are deferred.

### 12.4 Configuration writes

Saving goes through the host's config editor service (`dsh-config-editor`, present in `dsh-base`) rather than writing `cordis.patch.yml` directly, so validation, comments and live reload follow the host's rules. Every save shows a diff first. If the config editor is unavailable (e.g. no `profileContext`), the view is read-only and offers the YAML to copy.

### 12.5 Onboarding (implemented, phase 2 item ⑥)

1. **README quick start (3 steps)** — implemented at the top of the root README: add the core plus the rules classifier, restart and ask the agent what tools it has, then optionally add the panel.
2. **Scaffolder** `create-tool-manager-plugin` — implemented with four types (`classifier`, `filter`, `hook`, `declaration`). It writes a complete package (`package.json` with `dsh.bundle` and the peer dependency, `cordis.patch.yml`, `lib/index.js`, README, MIT LICENSE) **and a test that passes immediately**. It refuses to overwrite an existing package, normalizes the name to kebab-case, and exits non-zero with usage on a bad type.
3. **Runnable examples** — implemented as `examples/example-classifier` (a classifier plus `defineCategory`) and `examples/example-filter` (visibility narrowing). Two rather than four: the `declaration` case is covered by the scaffolder and the core README, and a quota hook adds nothing a reader cannot see in the hook section.
4. Panel tooltips → the core README's "Extending" section: still open (the panel is read-only in v1).

**Verification**: 13 unit tests for the scaffolder — including generating all four types and running each generated package's own test — and 5 for the examples (both through the real catalog builder, so a broken example fails the suite). Total: 98 unit tests and 29 end-to-end assertions.

## 13. Production-copy trial plan (phase 2 item ①; awaiting confirmation)

Goal: run the real `web` profile (all tool-registering plugins, real connectors) with this plugin, without side effects on the live DSH, and measure T12.

**Isolation**

- New `DSH_HOME` with a copied `profiles/web` (`package.json`, `cordis.patch.yml`; `node_modules` symlinked read-only) plus this repo's packages linked in. No `sessions/`, no credential store copy.
- New `HOME` for the process (temp dir), because `dsh-engram` (`~/.dsh/engram`), `dsh-memory` (`~/.dsh/...`) and `dsh-adb` (`~/.dsh/storages/dsh-adb`) write outside `DSH_HOME`. Read-only caches (`~/.npm`, nix profile) are symlinked so stdio connectors start without re-downloading.
- Web server on a different loopback port; no tunnel.
- `mcp_connector.json` reduced to the three enabled read-only connectors; grants directory not copied.

**Disabled in the copy** (outward-facing, stateful or irrelevant): chat/messaging bridges and bots, schedulers and automation, cross-session messaging, local model gateways, plugins that launch other agents, subscription accounts, voice input, the device-tunnel MCP client, and UI-only plugins (themes, widgets).

**Device isolation**: a new `HOME` does not isolate devices. The adb server is system-wide (port 5037) and `desktop-eyes` drives the real desktop. The copy sets `ADB_SERVER_PORT` to an unused port so its adb/phone tools cannot reach the real phone. Verified by reading source: `dsh-adb` and `dsh-phone-control` only register tools (and, for adb, a lazily mounted web RPC) at load; every adb invocation happens inside a tool call or an explicit RPC — no patrol or watchdog starts by itself — so both stay enabled.

**Kept** (register tools; act only when a tool is called; the scripted model calls none of them): device plugins (adb, phone, desktop), NixOS, browser, memory plugins, search, skills, video understanding, the MCP connector, context/cost/rewind helpers, the experimental agent-team and auto-review bundles, and the presets.

**Runs**

1. Scripted fake model (no cost): baseline tool count/tokens without the plugin vs. with it; directory over the real catalog; load/unload of real groups; subagent; resume.
2. **Gap fixed before the trial** (done): in the web profile most tools are registered in the **preset** layer, not globally. The catalog read only global `ctx.tools.schemas()`, so a non-pinned preset-layer tool was hidden yet absent from the directory. The catalog is now built per agent from global tools plus the agent's ancestor (preset) layers; agents with the same tool set share a cached catalog. Regression test: the `preset` e2e profile (headless does not compose presets, so the test kit reproduces a preset exactly as the registry does — `createScope` + `bindScopeParent`); it fails on the old code and passes on the fix.
3. T12 cache measurement with a real provider (DeepSeek proposed: reports cache-hit tokens per request, cheap; key passed by environment variable to the copy only). Because a real model may call real tools: tasks are limited to browsing the directory, loading, and read-only maps queries; the copy's approval policy is deny-by-default with only `tools_*` and `mcp__maps__*` allowed; device isolation as above. Same conversation with and without a mid-session load; compare provider-reported cached prompt tokens per request.

### 13.1 Trial results (2026-10-15, production `web` profile copy, `flagship` preset, DeepSeek `deepseek-flash`)

Setup as above. Sessions were started through the host webhook runtime (the same path as a web session: preset mounted before the first request), by `test/trial/driver`; requests went through `test/trial/record-proxy.mjs`, which logged the offered tools and the provider's usage. A global guard allowed only `tools_*` and `mcp__maps__*`. The key lived only in the proxy process's environment.

**Start-up cost (same prompt, first request)**

| | Tools offered | Tool schema chars | Prompt tokens (provider-reported) |
|---|---|---|---|
| without the plugin | 160 | 121,994 | 40,897 |
| with the plugin | 36 | 28,510 | 11,896 |
| saving | −124 (−78%) | −77% | **−29,001 (−71%) per request** |

The 36 visible tools: the pinned set, the three entry tools, and `send_message`, `spawn_teammate`, `team_task_*` — registered by the experimental agent-team plugin **in the agent's own scope**, which `restrict()` by design never narrows. Can be revisited with that plugin's author; harmless for now.

**T12 — prompt-cache impact of a mid-session load** (cache hit / prompt tokens per request)

| Step | Control (no load) | With load at step 3 |
|---|---|---|
| 1 | 11,392 / 11,966 | 11,392 / 11,975 |
| 2 | 11,904 / 12,294 | 11,904 / 12,506 |
| 3 | 12,160 / 12,371 | 12,416 / 12,602 (`tools_load` called) |
| 4 | 12,288 / 12,826 | **6,912 / 14,171** (first request with 12 maps tools) |
| 5 | 12,672 / 12,920 | 14,208 / 14,704 |

- A load costs **one** partial cache miss: ≈ 7,259 missed tokens at the next request instead of ≈ 500 — the prefix breaks where the new tools sort in (lexicographic order; `mcp__maps__*` lands mid-list), so everything after that point is re-read once. The following request is back to 97% hit.
- The loaded group itself adds ≈ 1.3k prompt tokens per request (12 maps schemas).
- Net: one load ≈ 6.7k extra uncached tokens once, versus ≈ 29k tokens saved on **every** request. Break-even within the first request after the load. The upstream ordering TODO (§6) would shrink the one-off miss but is low priority.

**What the −71% measures, and the acceptance line for new tool sources.** The saving above is the
**resident tool-definition** account: the schemas the model is offered on every request (pinned
tools, the fixed entry tools, and everything loaded for that agent). It is not "all context" —
tool results, conversation history and the system prompt sit outside it and are unaffected. Quote it
with that scope, and do not compare it with whole-context figures such as the 85% often cited for
tool-search setups.

Any change that adds a tool source — a new pack, an MCP connector, a device bundle — reports three
columns instead of one:

| New tools | Resident schema tokens added at start-up | Recall hit rate (`test/unit/recall-probe.test.mjs`) |
|---|---|---|
| how many | must stay near zero: entry tools are pinned, everything else loads on demand | must not fall below `BASELINE` |

A PR that grows the catalogue without holding the middle column near zero, or that lowers the
probe's hit rate, is not finished no matter how many tools it adds. The probe's `BASELINE` is a
ratchet: raise it with the number, never lower it to make a change pass.

**Retrieval in three steps.** A directory is only as good as the way a person asks for a tool. The
probe's 30 samples are half keyword-style ("install apk") and half how people really talk
("is my phone charged"). The retrieval path answers in three steps, cheapest first:

1. **Keyword** — every word of the query appears in the tool's name, group, category or description.
   This is what `tools_ls({query})` always did, and it needs nothing but the catalog.
2. **Ranked index** — when the keyword match found nothing, an in-process BM25 index over the same
   catalog scores the words instead of requiring all of them. It is built per catalog rebuild, costs
   memory and not tokens, and needs no model and no network. It closed four of the six
   plain-language misses: **29/30 = 96.7%** (measured 2026-11-06, up from 80.0%).
3. **Model fallback** — a request the keyword match could not read at all is worth one small-model
   call. `classifier-llm` registers a fallback with the core; the core asks it **only** when the
   keyword match was empty, so a clear query never reaches a model and a matched one never pays for
   it. With a model that understands the last sample, the probe measures **30/30 = 100%**.

The model step is off unless a model is configured, and the plugin that provides it is optional, so
the default product behaviour is step 1 plus step 2: ranked retrieval with no model at all.

For a change that adds retrieval rather than tools, the middle column is unchanged by construction:
the ranked index and the model fallback add **no** schema and **no** always-on tool. The probe
reports both numbers — `keyword recall` (steps 1 and 2) and `model recall` (all three).

**Findings outside this plugin**

- The trial surfaced a misplaced credential in a **historical** connector-policy snapshot of the host configuration (not in this plugin). It was rotated and removed; no action needed for users of this plugin.
- Trial lesson: when scanning a copied connector store, distinguish live connections from snapshots before drawing conclusions, and never copy credential stores into a trial home.
- Tool *results* are not in the session projection cache, so the trial did not inspect the maps answer's content; the call was made (the run continued to the final step).
