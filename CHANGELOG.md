# Changelog

## 0.5.0 — unreleased: renamed to Tool Ultra

Every package is renamed from `@lvy-jsd/dsh-tool-manager-<name>` to
`@lvy-jsd/dsh-tool-ultra-<name>`, all at 0.5.0; the core is
`@lvy-jsd/dsh-tool-ultra-core` and the scaffolder is
`@lvy-jsd/create-dsh-tool-ultra-plugin`. The repository is now
`lvy-jsd/dsh-tool-ultra`.

### Added

- Core: bare load/unload targets (for example `web`) fall back through registered `pack:` → `cap:` → `device:` namespaces, taking the first non-empty match before normal directory lookup. All three explicit prefixes retain their existing semantics and plugin ownership.
- Media: optional Gemini engine for `video_understand` and `audio_transcribe`, enabled by `geminiUploads: true` and a configured key. Uploads to Google are disclosed in each Gemini reply; failures fall back to local speech recognition with a short reason. Both tools retain ffprobe facts, video keeps its local storyboard, and audio saves SRT subtitles. Supports config/key-file/environment credentials and `engine: auto | local | gemini`.
- `@lvy-jsd/dsh-tool-ultra-pack-essentials`: the first native tool pack, with no API keys: `time_now`, `time_convert`, `date_diff`, `math_eval` (mathjs, with units), `weather_forecast` (Open-Meteo), `geo_search` (Nominatim) and `wiki_search` / `wiki_summary` (Wikimedia).
- `@lvy-jsd/dsh-tool-ultra-pack-web`: `web_read` (main article as Markdown via Readability + turndown) and `web_links`. Private, loopback and link-local targets are refused by default, and the check runs again on every redirect hop.
- `@lvy-jsd/dsh-tool-ultra-pack-control`: SSH control in two packs, with no npm dependencies. `ssh` (on by default, read-only): `ssh_hosts`, `ssh_sys`, `ssh_read`, `ssh_log`. `ssh-exec` (off by default): `ssh_run`, `ssh_write`, `ssh_get`, `ssh_put`. Hosts are aliases from the config (a model cannot name a free-form destination), the ssh client runs without a local shell and without password prompts, and credentials paths are refused by the read tools. Every call that may change something is confirmed by the user through a `tools/pre-execute` gate (a command that only reads, such as `uptime` or `systemctl status`, is let through; a session with nobody to ask is refused), `allow` lets chosen sessions skip the question, `readOnly` removes the changing tools, and a JSON-lines audit log records what ran. The tools are plain `ToolSpec` objects so another front end can reuse them. Verified end to end on DSH 0.2.2-rc.1 that `{ kind: 'ask' }` from `tools/pre-execute` stops an ordinary tool call, not only `tools_load`.
- `@lvy-jsd/dsh-tool-ultra-pack-mcp`: twelve MCP server presets started through `@deepseek-ai/dsh-mcp-client`. Keyless presets (memory, thinking, context7, playwright) start by default, keyed ones wait for their key, versions are pinned, and write tools are marked high risk. `mcp_presets` reports the status.
- `@lvy-jsd/dsh-tool-ultra-pack-media`: images made from code, with no model API and no key. `svg_render` renders an SVG drawing to PNG/JPEG/WebP (sharp), `chart_render` draws a Vega-Lite chart with inline data. `html_render` designs images in HTML and CSS with Takumi (Rust, no browser): flexbox, grid, gradients, shadows, filters and the host's Chinese and emoji fonts, as PNG/JPEG/WebP or, from CSS animations, an animated GIF/WebP; scripts, web fonts and links are refused, and pictures come only from the output folder or `inputDirs`. SVG links are allowlisted (`#id` and inline images only), charts cannot load data, and files go only into the configured `outputDir` without overwriting. `music_render` turns a score in a one-line note notation (`C4:1 [C4,E4,G4]:2 R:1`, drum letters such as `K`/`S`/`H`/`C`, drum chords `[K,C]:1`) for up to 16 of 37 General MIDI instruments into a MIDI file and a stereo WAV played with a SoundFont (spessasynth_core; FluidR3 Mono GM downloaded once and checked by SHA-256, or a local `soundfont`), with pan and reverb, mastered to −14 LUFS with a look-ahead limiter; a built-in synthesizer stands in if the SoundFont cannot load. `video_render` makes an H.264/AAC MP4 from scenes drawn frame by frame (CSS-animated HTML pages, SVG drawings, or photos with a slow camera move), joined by eased transitions (fade, slide, wipe, circle, cut), with captions or an `.srt`, an optional soundtrack from the output folder, and frames streamed into the host's ffmpeg, run without a shell and with a time limit. `audio_transcribe` turns speech in an audio or video file into timestamped text and SRT subtitles with local models on the CPU (sherpa-onnx): speaker diarization (who speaks when), SenseVoice for Chinese, Cantonese, English, Japanese and Korean with emotions and sounds such as laughter or music, and Whisper large-v3-turbo for other languages; models download once from the sherpa-onnx GitHub releases (`modelMirror`), checked by SHA-256; `video_understand` reports a video's length, size and frame rate (ffprobe), finds the cuts with ffmpeg's scene-change score and saves a storyboard of key frames that follow the shots, labelled with their times, and lists when the scene changes, and adds the transcript. Files are read only from the output folder or configured `inputDirs`.
- Tool packs: the core's `toolCatalog.registerToolPack()` / `toolPacks()` and the `pack:<id>` target, so `tools_load(["pack:web"])` loads a whole pack. The packs register themselves, and the panel has a Packs tab with per-preset status and one-click load.
- `@lvy-jsd/dsh-tool-ultra-devices`: the device namespace. Swiftnest device tools (`device__<slug>__<capability>`) are filed under `/device/<slug>`, `device:current` / `device:all` / `device:<slug>[/<capability>]` load them, and offline devices are marked in `tools_ls`.
- Core: target resolvers receive the calling agent (so `device:current` can answer per session), and `toolCatalog.registerGroupNote()` adds short notes to group lines in `tools_ls`.
- `scripts/smoke-packs.mjs`: a live check of the packs against the real services, including starting each keyless MCP preset.

### Changed

- Media: `geminiUploads` defaults to `false`, so a shared vision key cannot silently enable audio/video uploads to Google. With uploads off, `auto` stays quietly local and explicit `gemini` adds one localized reason line; neither reads the key nor makes Gemini requests.
- Works with DSH 0.2.2 (tested on 0.2.2-alpha.3) as well as 0.2.1-rc.5. DSH 0.2.2 fixes a step's callable tools when the step starts, so a direct call of a hidden ordinary tool now loads it and asks the model to call it again, instead of running in the same step. CI runs the e2e suite against both DSH versions.
- **License: Apache-2.0** from this release on. Releases up to 0.4.1 stay MIT.
- The core also provides its service as `toolUltra`; `toolCatalog` stays.

### Fixed

- `classifier-llm`: `parseCategory` accepts an answer only when it names exactly
  one category. Small/local models often answer with Markdown, prose or a
  restated category list; the old code returned the first category in
  declaration order and cached that guess forever. Ambiguous answers now leave
  the group uncategorized instead of a wrong permanent classification.
- `pack-essentials`: `math_eval` refuses expressions whose meaning mathjs 15
  changed instead of returning a different answer: a unary percentage followed
  by `+` or `-` (`50% + 10` was `0.5 + 10` on mathjs 14 and is `50 % (+10)` on
  15). The error names the parenthesized form, `(50%) + 10`, and the tests pin
  the changed forms, the unchanged ones (`100 - 20%`, `50% * 3400`, `5 % 2`)
  and the parenthesized ones.

### Security

- `pack-essentials`: mathjs 15.2.0 replaces 14.9.1, which two high-severity
  advisories affect with no 14.x fix: `GHSA-29qv-4j9f-fjw5` (CVE-2026-40897,
  unsafe object property setter, from 13.1.1) and `GHSA-jvff-x2qm-6286`
  (CVE-2026-41139, prototype pollution, from 13.1.0). Both are fixed in 15.2.0.

### Compatibility

- Unchanged: plugin name `tool-manager`, loader id, config keys, entry tools
  (`tools_ls` / `tools_load` / `tools_unload` / `tools_find` / `tools_route` /
  `skills_find` / `skills_route`), `tool-catalog/*` hooks, and the state
  directory `<DSH_HOME>/tool-manager/`.
- `@lvy-jsd/dsh-tool-manager` 0.5.0 re-exports the new core, so a profile that
  loads it keeps working. Do not load it and `@lvy-jsd/dsh-tool-ultra-core` together.
- Older `dsh-tool-manager-*` extension releases work with the new core through
  the unchanged `toolCatalog` service.
- `@lvy-jsd/dsh-tool-manager-dsbot-entry` is deprecated and not released again.

## 0.4.1 — 2026-11-01

Packages: `@lvy-jsd/dsh-tool-manager` 0.4.1. The other packages are unchanged.

### Fixed

- **Windows (and other non-Linux) crash on mount** (#1, fixed in #2). The bundled
  retrieval sidecar is a Linux-only binary; starting it elsewhere emitted an
  unhandled `error` event and took the DSH host down. The sidecar is now skipped
  on non-Linux platforms, spawn errors are handled, and retrieval falls back to
  the JS BM25 index.

## 0.3.0 — 2026-10-22

Packages: `@lvy-jsd/dsh-tool-manager` 0.3.0, `@lvy-jsd/dsh-tool-manager-panel` 0.2.0,
`@lvy-jsd/dsh-tool-manager-classifier-rules` 0.2.0. The other packages are unchanged.

Tested on DSH 0.2.0-rc.2 and 0.2.1-rc.2.

### Fixed

- **PTC mode** (`DSH_TOOLS_MODE=ptc`) works. The core used to catalogue the host's
  `run_code` transport as an ordinary hidden tool and refuse every call to it.

### Added

- **`[denied]` marks.** A pinned or loaded tool that another plugin still hides (MCP
  connector governance, the connector's per-session injection, any `restrict()`) is
  marked in `tools_ls`, reported as not callable by `tools_load`, and logged once.
  New service method `deniedFor(agent)`.
- **Settings page editing** (panel 0.2.0, needs core 0.3.0): edit the always-on and
  high-risk lists, view and edit a tool's metadata (group, category, risk, summary),
  exempt a single session, and tidy uncategorized groups with a model.
- **Exemption file**: `<DSH_HOME>/tool-manager/exempt.json` replaces the configured
  `exemptProviders` when present, and can exempt single sessions.
- **Catalog file** for clients that cannot lazy-load: the directory index is written
  out after every rebuild (`manifestFile`, empty to turn off).
- **Default rules for common MCP server names** (classifier-rules 0.2.0): search
  servers → `search`, email servers → a new `mail` category, browser automation
  servers → `browser`.

### Tests

- The e2e harness drives concurrent subagents (DSH 0.2.1 never waits for a child).
- New e2e runs: `deny` (another plugin's deny) and `ptc` (PTC mode).
- New unit tests: the start-up window (agents that exist before the plugin mounts) and
  the MCP-name defaults.
