<p align="center">
  <b>Tool Ultra</b><br>
  为 DeepSeek Harness 按需加载工具 —— 所有工具组织成目录，只有 Agent 主动加载的才进入上下文。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="许可证：Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@lvy-jsd/dsh-tool-ultra-core"><img src="https://img.shields.io/npm/v/@lvy-jsd/dsh-tool-ultra-core.svg" alt="npm：@lvy-jsd/dsh-tool-ultra-core"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 中文
</p>

---

## 它是什么

Tool Ultra 是面向 DeepSeek Harness 的 **All-in-One 工具插件产品**，也是 [Swiftnest](https://github.com/lvy-jsd/swiftnest) 的重要组成部分。目标是以一个连贯的工具产品覆盖日常任务、网页/MCP 服务、媒体与设备能力。小核心与可替换扩展包是内部架构，产品不只是一份工具目录。

工具组织为目录（分类 → 分组 → 工具），支持按意图检索和按需加载，避免把不需要的工具说明放进模型上下文。节省幅度受目录大小、发现/加载步骤和服务端缓存影响，应分别比较单次工具说明、整项任务的 token 与任务成功率；能力全面不等于默认开启所有外部服务或上传。

当前预览版以源码和模块包组织，Swiftnest 从固定提交构建；安装和配置可交给 AI。下方发布包的快速开始命令适用于对应版本已上架 npm 的情况，不代表改名后的 0.5.0 包已经发布。

> **已改名。** 本项目原名 `dsh-tool-manager`。从 0.5.0 起，所有包从 `@lvy-jsd/dsh-tool-manager-<名字>`
> 改名为 `@lvy-jsd/dsh-tool-ultra-<名字>`（核心是 `@lvy-jsd/dsh-tool-ultra-core`）。其他都不变：入口工具、
> `toolCatalog` 服务（另外也以 `toolUltra` 的名字提供）、钩子、配置和状态目录 `<DSH_HOME>/tool-manager/`。
> 已有的配置可以继续用 `@lvy-jsd/dsh-tool-manager`：从 0.5.0 起它只是转出新核心。旧版扩展也能和新核心一起用。

## 快速开始

```sh
# 1. 安装核心包和基于规则的分类器（可选，但推荐）
dsh plugin --profile web add @lvy-jsd/dsh-tool-ultra-core @lvy-jsd/dsh-tool-ultra-classifier-rules

# 2. 重启 DSH，然后问 Agent："你有哪些工具？"
#    它会用 tools_ls("/") 回答 —— 是一个目录，不是 200 个工具 schema

# 3. 想要界面？装上面板，然后打开 设置 →"工具管理"
dsh plugin --profile web add @lvy-jsd/dsh-tool-ultra-panel
```

> **请安装带 scope 的 `@lvy-jsd/…` 包。** npm 上不带 scope 的 `dsh-tool-manager`
> 是另一个项目。不要两个同时安装：两者都会收窄 Agent 能看到的工具，装在一起会互相把对方的工具藏起来。

全新安装后，所有分组都归在 `uncategorized` 下，直到装上分类器 ——
工具本身仍然可以浏览和加载，只是缺了分类。想自己写分类器见
[扩展](#extending)。

`tools_load(["web"])` 也接受裸名：按已注册的 `pack:` → `cap:` → `device:` 命名空间依次尝试，只取第一个非空匹配，未命中则按原目录逻辑查找；显式前缀的行为与插件归属不变。

## 包

| 包 | 作用 |
|---|---|
| [`@lvy-jsd/dsh-tool-ultra-core`](packages/dsh-tool-ultra-core) | 核心：目录、`tools_ls` / `tools_load` / `tools_unload`、按 Agent 的可见白名单、`toolCatalog` 扩展服务，外加按意图的检索与路由（`tools_find` / `tools_route` / `skills_find` / `skills_route`，BM25 + Rust 侧车）。没有扩展时所有分组都在 `uncategorized` 下。 |
| [`@lvy-jsd/dsh-tool-ultra-classifier-rules`](packages/dsh-tool-ultra-classifier-rules) | 按内置规则和你的配置覆盖，把分组放进分类。 |
| [`@lvy-jsd/dsh-tool-ultra-risk-gate`](packages/dsh-tool-ultra-risk-gate) | 通过 DSH 的审批通道确认高危工具的加载，并支持按会话的白名单。 |
| [`@lvy-jsd/dsh-tool-ultra-persist`](packages/dsh-tool-ultra-persist) | DSH 重启后保留已加载的工具，每个会话一个状态文件。 |
| [`@lvy-jsd/dsh-tool-ultra-panel`](packages/dsh-tool-ultra-panel) | 网页面板：浏览目录树、查看每个活动会话已加载的工具和 token 开销，在界面上加载 / 卸载，编辑常驻工具和高危名单，编辑单个工具的元数据，以及豁免某个会话。 |
| [`@lvy-jsd/dsh-tool-ultra-classifier-llm`](packages/dsh-tool-ultra-classifier-llm) | 用小模型给分组分类，每个分组一次请求，按分组及其工具描述的哈希缓存结果。 |
| [`@lvy-jsd/dsh-tool-ultra-capability-bridge`](packages/dsh-tool-ultra-capability-bridge) | 一次调用加载一组具名工具：`tools_load(["cap:android-debug"])`。 |
| [`@lvy-jsd/dsh-tool-ultra-attribution-scan`](packages/dsh-tool-ultra-attribution-scan) | 按定义这些工具的源码所属的插件包来分组。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-essentials`](packages/dsh-tool-ultra-pack-essentials) | 原生工具包，无需 API key：时区与日期计算、带单位的计算器（mathjs）、天气（Open-Meteo）、地点搜索（Nominatim）、维基百科。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-web`](packages/dsh-tool-ultra-pack-web) | 原生工具包：`web_read` 把网页正文转成干净的 Markdown（Readability + turndown），`web_links` 列出页面链接。默认拒绝访问内网地址。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-mcp`](packages/dsh-tool-ultra-pack-mcp) | 通过 DSH 的 MCP 客户端启动预设的 MCP 服务器：记忆、顺序思考、Context7、Playwright、文件系统无需 key 就能用；GitHub、SearXNG、Brave、Tavily、Firecrawl、Notion、高德地图在填好 key 后启动。用 `mcp_presets` 查看状态。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-media`](packages/dsh-tool-ultra-pack-media) | 原生工具包，无需 API key，用代码生成图片、音乐和视频：`html_render` 用 HTML/CSS 设计图片（不需要浏览器），也能把 CSS 动画做成动图，`svg_render` 把 SVG 画稿渲染成 PNG/JPEG/WebP，`chart_render` 用 Vega-Lite 画图表，`music_render` 用真实采样乐器（SoundFont，自动母带处理）演奏乐谱，存成 WAV 和 MIDI，`video_render` 用 CSS 动画的 HTML 页面、SVG 或照片场景加转场、字幕和配乐做成 MP4（用服务器上的 ffmpeg），`audio_transcribe` 用本地 SenseVoice / Whisper 模型把语音转成带时间戳的文字，并区分说话人、标出情绪和笑声、音乐等声音，`video_understand` 把视频变成带时间的关键帧故事板图片和文字稿。拒绝外部链接和外部数据。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-gc`](packages/dsh-tool-ultra-pack-gc) | 制品与临时媒体垃圾回收：按日期分区存储（`[YYYY-MM-DD]`）、定时留存清理与 LRU 容量淘汰。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-db`](packages/dsh-tool-ultra-pack-db) | 嵌入式 DuckDB 内存数据分析：SQL 零拷贝直接查询分析 CSV、Parquet 与 JSON，无需大文件塞入上下文。 |
| [`@lvy-jsd/dsh-tool-ultra-pack-office`](packages/dsh-tool-ultra-pack-office) | 办公文档处理包：Word (.docx) 文本提取、Excel (.xlsx) 结构化读写及 PDF 基础元数据检视。 |
| [`@lvy-jsd/dsh-tool-ultra-devices`](packages/dsh-tool-ultra-devices) | 设备命名空间：Swiftnest 连进来的设备工具放在 `/device/<设备>` 下，可用 `device:current`、`device:all`、`device:<名字>` 加载，离线设备会标出来。 |
| [`@lvy-jsd/dsh-tool-manager-dsbot-entry`](packages/dsh-tool-manager-dsbot-entry) | 已弃用，不再发版。在 ds-bot 的设置弹窗里加一行"工具管理"，点开显示面板。 |
| [`@lvy-jsd/dsh-tool-manager`](packages/dsh-tool-manager) | 旧的核心包名：转出 `@lvy-jsd/dsh-tool-ultra-core`，让已有配置继续可用。 |
| [`@lvy-jsd/create-dsh-tool-ultra-plugin`](packages/create-dsh-tool-ultra-plugin) | 生成你自己的扩展：`npm create @lvy-jsd/dsh-tool-ultra-plugin@latest my-ext -- --type classifier`。 |

设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

<a id="extending"></a>
## 扩展

核心之外的所有功能都是使用 `toolCatalog` 服务的普通插件，仓库里的
`classifier-rules` 就是完全按第三方的写法写的。有四个扩展点：

| 扩展点 | 用途 |
|---|---|
| `registerClassifier({ name, priority, group?, categorize? })` | 把工具放进分组、把分组放进分类 |
| `annotate(match, { group?, category?, risk?, summary? })` | 运行时元数据；`package.json` 里的 `dsh.toolCatalog` 不用写代码也能达到同样效果 |
| `registerVisibilityFilter({ name, filter(agent, names) })` | 收窄某个 Agent 能看到的范围 —— 只能移除名字 |
| `registerTargetResolver({ name, prefix, resolve })` | 认领一个目标前缀，例如 `cap:<name>` |
| `registerRiskGate` / `registerStateProvider` | 确认高危工具的加载 / 跨重启保留状态 |

钩子就是普通事件：`tool-catalog/before-load`（抛异常即否决）、
`after-load`、`before-unload`、`after-unload`、`before-rebuild`、
`after-rebuild`、`state-changed`。

从一个生成出来的包开始 —— 它自带一个能跑通的测试：

```sh
npm create @lvy-jsd/dsh-tool-ultra-plugin@latest my-ext -- --type classifier
cd my-ext && npm test
```

[`examples/`](examples) 里有两个完整的例子，完整接口列表在核心包的
README 和 [docs/DESIGN.md](docs/DESIGN.md) 第 11 节。

## 开发

所有包都用 TypeScript 编写（`src/`），编译到 `lib/`（JavaScript 加 `.d.ts` 类型声明）；
`lib/` 是构建产物，不进 git。构建和类型检查前，`scripts/generate-ts-projects.mjs`
自动扫描真实包目录中的 `packages/*/tsconfig.json` 与 `tsconfig.client.json`，按固定顺序生成
不进 git 的 `tsconfig.projects.generated.json`；根 `tsconfig.json` 只是固定入口。
**新增包只加目录和本包配置，不再改共享引用列表**。扫描不递归到依赖、不跟随目录符号链接，
不把测试或其它额外配置误当构建入口。浏览器端模块仍用独立 `tsconfig.client.json`，因为 DSH
把它们当经典脚本加载。仅更新编辑器索引时可执行 `npm run generate:ts-projects`；
`npm install`、构建和类型检查会自动生成。新克隆优先使用 npm 命令，裸 `tsc -b` 需先生成解决方案。

```sh
npm install                        # 同时把本机 DSH 的宿主包链接进来（scripts/link-host.mjs）
npm run build                      # src/*.ts -> lib/*.js + lib/*.d.ts
npm run typecheck                  # 严格类型检查（tsc -b；项目引用需要声明文件，所以也会写 lib/）
node --test test/unit/*.test.mjs   # 纯 catalog 与注册表测试（需先构建）
node test/e2e.mjs                  # 启动一次性 DSH 实例；绝不碰你的正式 profile
```

宿主包（`@deepseek-ai/*`）是 peer 依赖，永远不从 npm 安装（`.npmrc` 设了
`legacy-peer-deps`）：插件旁边多一份 npm 的副本，会遮蔽你实际运行的 DSH。
`npm install` 会改为从 `$DSH_APP`（默认 `~/.local/share/deepseek-harness/app`）链接。

## 许可

Apache-2.0 —— 见 [LICENSE](LICENSE)。改名为 Tool Ultra 之前的版本（`@lvy-jsd/dsh-tool-manager*`）是 MIT。