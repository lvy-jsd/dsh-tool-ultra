// A tool manifest on disk, so a client that cannot lazy-load can still find tools.
//
// Claude Code (driven by dsh-oh-my-claude) receives dsh tools once per session
// over an MCP bridge, built from what the session's agent can see at that
// moment. The directory keeps ~240 tools out of every request, so what that
// bridge lists is the always-on set plus `tools_ls`/`tools_load` — and nothing
// tells Claude the directory exists, so it never asks.
//
// This file answers "what is there" without a call: the catalog as text, plus
// the two tool names that load the rest. It is written next to Claude Code's
// own instructions and pulled in with an `@` line, so every Claude session reads
// it the same way it reads CLAUDE.md.
//
// Written after every catalog rebuild, and only when the text changed: the file
// is part of a prompt, so a rewrite that changes nothing still costs a re-read
// and a cache miss.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Catalog, Logger } from './types.js'

/** Where the manifest goes unless a deployment points elsewhere. */
export function defaultManifestFile(): string {
  return join(homedir(), '.claude', 'dsh-tool-catalog.md')
}

/** One line describing what to do with this file, so a model reads it as instructions. */
const HEADER = [
  '# dsh tool catalog',
  '',
  'dsh keeps most of its tools out of every request and hands them out on demand.',
  'The tools listed below are NOT callable yet — this file is the index, not the tools.',
  '',
  'To use one:',
  '',
  '- `tools_ls` browses the same tree as text: no argument lists categories, a',
  '  category name lists its groups, a group lists its tools. `tools_ls({ query })`',
  '  searches every name and description at once. Long listings are paginated;',
  '  the hint at the end says how to continue.',
  '- `tools_load` makes tools callable for the rest of the session. Pass group',
  '  paths (`/code/github`), a category (`/maps`), or exact tool names.',
  '- Load the smallest thing that covers the task. A whole category costs more',
  '  context than the one group you need.',
  '- High-risk tools (marked `!`) need a risk gate to confirm them; with none',
  '  installed, loading them is refused.',
  '',
  'This file is regenerated whenever the catalog changes; do not edit it.',
  '',
].join('\n')

/**
 * The catalog as markdown: category, then group, then tool names with their
 * summaries. Summaries are cut to one line so a group of 30 tools stays
 * scannable, and the counts let a reader judge a load before making it.
 */
export function renderManifest(catalog: Catalog): string {
  const out: string[] = [HEADER]
  const categories = [...catalog.categories.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const category of categories) {
    const tools = category.groups.flatMap((group) => group.tools)
    if (tools.length === 0) continue
    out.push(`## ${category.name} (${tools.length} tools, ${category.description || 'no description'})`, '')
    for (const group of [...category.groups].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`### ${group.name} — load with \`tools_load({ targets: ["/${category.name}/${group.name}"] })\``)
      for (const tool of group.tools) {
        const risk = tool.highRisk ? ' !' : ''
        const summary = tool.summary ? ` — ${tool.summary}` : ''
        out.push(`- ${tool.name}${risk}${summary}`)
      }
      out.push('')
    }
  }
  out.push('## Also always available', '')
  out.push('- `tools_ls`, `tools_load`, `tools_unload` — the directory itself.', '')
  return out.join('\n')
}

/** The smallest change worth a rewrite: identical text means no write at all. */
function sameFile(file: string, text: string): boolean {
  try {
    return readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

/** Write atomically; a crash cannot leave a half-written prompt. */
export function writeManifest(file: string, text: string, logger?: Logger): boolean {
  if (sameFile(file, text)) return false
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
    return true
  } catch (caught) {
    // A read-only home is not a reason to break the catalog; the panel still works.
    logger?.warn?.(`tool-manager: writing the tool manifest ${file} failed: ${(caught as Error).message}`)
    return false
  }
}

/** Write the manifest for this catalog, if it changed. */
export function syncManifest(catalog: Catalog, file: string, logger?: Logger): boolean {
  return writeManifest(file, renderManifest(catalog), logger)
}

/**
 * The `@` line a CLAUDE.md needs to pull the manifest in.
 *
 * `@` has to open the line or follow whitespace, and a path with spaces is
 * escaped — the same rules Claude Code applies to its own imports.
 */
export function manifestImport(file: string): string {
  return `@${file.replace(/ /g, '\\ ')}`
}
