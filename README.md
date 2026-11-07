<p align="center">
  <b>Tool Ultra</b><br>
  On-demand tool loading for DeepSeek Harness — every tool as a directory, loaded only when an agent asks.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@lvy-jsd/dsh-tool-ultra-core"><img src="https://img.shields.io/npm/v/@lvy-jsd/dsh-tool-ultra-core.svg" alt="npm: @lvy-jsd/dsh-tool-ultra-core"></a>
</p>

<p align="center">
  English · <a href="README.zh.md">中文</a>
</p>

---

## What It Is

Tool Ultra is an All-in-One tool-plugin product for DeepSeek Harness, and an important component of [Swiftnest](https://github.com/lvy-jsd/swiftnest). Its goal is one coherent tool product across everyday tasks, web/MCP services, media and device capabilities. The small core and replaceable extension packages are its internal architecture; the product is more than a tool-directory browser.

Tools are browsable as a directory (category → group → tool), searchable by intent and loaded on demand, keeping unneeded schemas out of the model's context. Savings depend on catalog size, discovery/load steps and provider caching: compare per-request schemas, total task tokens and task success separately. Broad capability does not mean every external service or upload is enabled by default.

The current preview is distributed as source and modular packages; Swiftnest builds a pinned source commit. An AI can install and configure the required modules. The published-package quick-start syntax below applies when those package versions are available on npm; it is not a claim that the renamed 0.5.0 packages have already been published.

> **Renamed.** This project was `dsh-tool-manager`. Version 0.5.0 renames every
> package from `@lvy-jsd/dsh-tool-manager-<name>` to `@lvy-jsd/dsh-tool-ultra-<name>`
> (the core is `@lvy-jsd/dsh-tool-ultra-core`). Nothing else changes: the entry
> tools, the `toolCatalog` service (now also provided as `toolUltra`), the hooks,
> the config and the state directory `<DSH_HOME>/tool-manager/` stay the same.
> An existing profile can keep `@lvy-jsd/dsh-tool-manager`: from 0.5.0 it only
> re-exports the new core. Older extension releases keep working with the new core.

## Quick start

```sh
# 1. install the core plus the rule-based classifier (optional but recommended)
dsh plugin --profile web add @lvy-jsd/dsh-tool-ultra-core @lvy-jsd/dsh-tool-ultra-classifier-rules

# 2. restart DSH, then ask the agent: "what tools do you have?"
#    it answers with tools_ls("/") — a directory, not 200 tool schemas

# 3. want the UI? add the panel, then open Settings → "Tool manager"
dsh plugin --profile web add @lvy-jsd/dsh-tool-ultra-panel
```

> **Install the scoped `@lvy-jsd/…` packages.** The unscoped `dsh-tool-manager`
> on npm is a different project. Do not install both: each one narrows which
> tools an agent can see, so together they hide tools from each other.

On a fresh install every group is `uncategorized` until a classifier is
installed — the tools are still browsable and loadable, only the categories are
missing. See [Extending](#extending) to write your own classifier.

`tools_load(["web"])` also accepts bare names: try registered `pack:` → `cap:` → `device:` namespaces, first non-empty match only, then normal directory lookup; explicit prefixes keep their behavior and plugin ownership.

## Packages

| Package | What it does |
|---|---|
| [`@lvy-jsd/dsh-tool-ultra-core`](packages/dsh-tool-ultra-core) | Core: directory, `tools_ls` / `tools_load` / `tools_unload`, per-agent allowlist, the `toolCatalog` extension service, plus intent retrieval + routing (`tools_find` / `tools_route` / `skills_find` / `skills_route`, BM25 with a Rust sidecar). Without extensions every group is `uncategorized`. |
| [`@lvy-jsd/dsh-tool-ultra-classifier-rules`](packages/dsh-tool-ultra-classifier-rules) | Places groups into categories from built-in rules and your config overrides. |
| [`@lvy-jsd/dsh-tool-ultra-risk-gate`](packages/dsh-tool-ultra-risk-gate) | Confirms loading high-risk tools through the DSH approval channel, with a per-session allowlist. |
| [`@lvy-jsd/dsh-tool-ultra-persist`](packages/dsh-tool-ultra-persist) | Keeps loaded tools across a DSH restart, one state file per session. |
| [`@lvy-jsd/dsh-tool-ultra-panel`](packages/dsh-tool-ultra-panel) | Web panel: browse the tree, see each live session's loaded tools and token cost, load/unload from the UI, edit the always-on and high-risk lists, edit one tool's metadata, exempt one session. |
| [`@lvy-jsd/dsh-tool-ultra-classifier-llm`](packages/dsh-tool-ultra-classifier-llm) | Places groups with a small model, one request per group, cached by a hash of the group and its tool descriptions. |
| [`@lvy-jsd/dsh-tool-ultra-capability-bridge`](packages/dsh-tool-ultra-capability-bridge) | Load a named bundle of tools in one call: `tools_load(["cap:android-debug"])`. |
| [`@lvy-jsd/dsh-tool-ultra-attribution-scan`](packages/dsh-tool-ultra-attribution-scan) | Group tools by the plugin package whose source defines them. |
| [`@lvy-jsd/dsh-tool-ultra-pack-essentials`](packages/dsh-tool-ultra-pack-essentials) | Native tool pack, no API keys: time zones and date math, a calculator with units (mathjs), weather (Open-Meteo), place search (Nominatim), Wikipedia. |
| [`@lvy-jsd/dsh-tool-ultra-pack-web`](packages/dsh-tool-ultra-pack-web) | Native tool pack: `web_read` turns a page into clean Markdown (Readability + turndown), `web_links` lists its links. Refuses private addresses by default. |
| [`@lvy-jsd/dsh-tool-ultra-pack-mcp`](packages/dsh-tool-ultra-pack-mcp) | MCP presets through DSH's MCP client: memory, sequential thinking, Context7, Playwright and filesystem start without keys; GitHub, SearXNG, Brave, Tavily, Firecrawl, Notion and AMap start once their key is set. `mcp_presets` shows the status. |
| [`@lvy-jsd/dsh-tool-ultra-pack-media`](packages/dsh-tool-ultra-pack-media) | Native tool pack, no API keys: images, music and video made from code. `html_render` designs an image in HTML/CSS (no browser) or turns its CSS animations into a GIF, `svg_render` turns an SVG drawing into PNG/JPEG/WebP, `chart_render` draws a Vega-Lite chart, `music_render` plays a score with real recorded instruments (SoundFont, mastered) and saves WAV and MIDI, `video_render` makes an MP4 from CSS-animated HTML, SVG or photo scenes with transitions, captions and a soundtrack (host ffmpeg), `audio_transcribe` turns speech into timestamped text with local SenseVoice / Whisper models, with who speaks when, emotions and sounds such as laughter, `video_understand` reads a video as a timestamped storyboard image plus its transcript. External links and data URLs are refused. |
| [`@lvy-jsd/dsh-tool-ultra-pack-gc`](packages/dsh-tool-ultra-pack-gc) | Artifact and media garbage collection: date-partitioned storage management (`[YYYY-MM-DD]`), retention sweeps, and LRU capacity eviction. |
| [`@lvy-jsd/dsh-tool-ultra-pack-db`](packages/dsh-tool-ultra-pack-db) | In-memory OLAP analytics via embedded DuckDB: query CSV, Parquet, and JSON datasets directly via SQL without context inflation. |
| [`@lvy-jsd/dsh-tool-ultra-pack-office`](packages/dsh-tool-ultra-pack-office) | Office documents pack: Word (.docx) text extraction, Excel (.xlsx) read/write, and PDF document metadata inspection. |
| [`@lvy-jsd/dsh-tool-ultra-devices`](packages/dsh-tool-ultra-devices) | Device namespace: Swiftnest device tools under `/device/<device>`, loadable as `device:current`, `device:all` or `device:<name>`, with offline devices marked. |
| [`@lvy-jsd/dsh-tool-manager-dsbot-entry`](packages/dsh-tool-manager-dsbot-entry) | Deprecated, no longer released. A "Tool manager" row in the ds-bot settings dialog that opens the panel. |
| [`@lvy-jsd/dsh-tool-manager`](packages/dsh-tool-manager) | The old core name: re-exports `@lvy-jsd/dsh-tool-ultra-core` so existing profiles keep working. |
| [`@lvy-jsd/create-dsh-tool-ultra-plugin`](packages/create-dsh-tool-ultra-plugin) | Scaffold your own extension: `npm create @lvy-jsd/dsh-tool-ultra-plugin@latest my-ext -- --type classifier`. |

See [docs/DESIGN.md](docs/DESIGN.md) for the design.

<a id="extending"></a>
## Extending

Every feature beyond the core is an ordinary plugin using the `toolCatalog`
service, and the bundled `classifier-rules` package is written exactly as a
third party would write it. Four extension points:

| Point | For |
|---|---|
| `registerClassifier({ name, priority, group?, categorize? })` | placing tools into groups and groups into categories |
| `annotate(match, { group?, category?, risk?, summary? })` | runtime metadata; `package.json` `dsh.toolCatalog` does the same without code |
| `registerVisibilityFilter({ name, filter(agent, names) })` | narrowing what one agent may see — can only remove names |
| `registerTargetResolver({ name, prefix, resolve })` | owning a target prefix, e.g. `cap:<name>` |
| `registerRiskGate` / `registerStateProvider` | confirming high-risk loads / keeping state across a restart |

Hooks are plain events: `tool-catalog/before-load` (throw to veto),
`after-load`, `before-unload`, `after-unload`, `before-rebuild`, `after-rebuild`,
`state-changed`.

Start from a generated package — it comes with a passing test:

```sh
npm create @lvy-jsd/dsh-tool-ultra-plugin@latest my-ext -- --type classifier
cd my-ext && npm test
```

Two worked examples live in [`examples/`](examples), and the full interface list
is in the core README and [docs/DESIGN.md](docs/DESIGN.md) §11.

## Development

Every package is written in TypeScript (`src/`) and compiled to `lib/`
(JavaScript plus `.d.ts` type declarations); `lib/` is build output and not
committed. The root `tsconfig.json` lists the packages (project references); the
two browser halves (`client.ts`) have their own `tsconfig.client.json`, because
DSH loads them as classic scripts, not modules.

```sh
npm install                        # also links your local DSH host packages (scripts/link-host.mjs)
npm run build                      # src/*.ts -> lib/*.js + lib/*.d.ts
npm run typecheck                  # strict type check (tsc -b; writes lib/ too, references need it)
node --test test/unit/*.test.mjs   # pure catalog and registry tests (needs a build)
node test/e2e.mjs                  # boots throwaway DSH instances; never touches your profile
```

Host packages (`@deepseek-ai/*`) are peers and are never installed from the
registry (`.npmrc` sets `legacy-peer-deps`): a registry copy next to the plugin
would shadow the DSH you actually run. `npm install` links them from
`$DSH_APP` (default `~/.local/share/deepseek-harness/app`) instead.

## License

Apache-2.0 — see [LICENSE](LICENSE). Releases before Tool Ultra (`@lvy-jsd/dsh-tool-manager*`) were MIT.