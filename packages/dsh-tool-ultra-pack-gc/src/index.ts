/**
 * Tool Ultra Artifact GC pack:
 * Automatic and manual cleanup for tool artifacts, media outputs, and exported files.
 * Organized into date-partitioned directories [YYYY-MM-DD].
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_ARTIFACTS_DIR,
  formatBytes,
  formatDate,
  getDailyArtifactDir,
  scanArtifacts,
  sweepArtifacts,
  type GcResult,
  type ArtifactOverview,
} from './gc.js'

export {
  DEFAULT_ARTIFACTS_DIR,
  formatBytes,
  formatDate,
  getDailyArtifactDir,
  scanArtifacts,
  sweepArtifacts,
  type GcResult,
  type ArtifactOverview,
}

export const name = 'tool-ultra-pack-gc'
export const inject = ['tools']

export interface Config {
  disable?: string[]
  artifactsDir?: string
  retentionDays?: number
  maxMegabytes?: number
  autoIntervalMs?: number
}

export const TOOL_NAMES = ['gc_status', 'gc_cleanup'] as const

const DEFAULTS = {
  retentionDays: 7,
  maxMegabytes: 2048,
  autoIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

export function createTools(config: Config = {}) {
  const root = config.artifactsDir || DEFAULT_ARTIFACTS_DIR
  const defaultRetention = config.retentionDays ?? DEFAULTS.retentionDays
  const defaultMaxMb = config.maxMegabytes ?? DEFAULTS.maxMegabytes

  return [
    {
      name: 'gc_status' as const,
      description:
        'Inspect the artifacts and generated media storage: reports root directory, total files, total disk usage, and a breakdown per daily folder [YYYY-MM-DD].',
      parameters: {
        path: {
          type: 'string',
          description: 'Optional custom artifact root directory to inspect. Defaults to standard artifacts storage.',
        },
      },
      async execute(args: { path?: string }): Promise<string> {
        const targetRoot = args.path || root
        const overview = await scanArtifacts(targetRoot)
        if (overview.daysCount === 0) {
          return `Artifact storage at ${targetRoot} is currently empty or does not exist.`
        }

        const lines = [
          `Artifact Storage: ${overview.rootDir}`,
          `Total Size: ${formatBytes(overview.totalBytes)} across ${overview.totalFiles} file(s) in ${overview.daysCount} day(s)`,
          '',
          'Daily Breakdown (Oldest to Newest):',
        ]

        for (const day of overview.days) {
          lines.push(`- [${day.date}]: ${day.fileCount} file(s), ${formatBytes(day.totalBytes)}`)
        }

        return lines.join('\n')
      },
    },
    {
      name: 'gc_cleanup' as const,
      description:
        'Clean up old or overflowing tool artifacts and media files. Deletes daily folders older than retention days and enforces maximum disk capacity by evicting oldest dates first.',
      parameters: {
        retention_days: {
          type: 'number',
          description: `Keep folders from the last N days. Older dates are deleted. Defaults to ${defaultRetention}.`,
        },
        max_mb: {
          type: 'number',
          description: `Max storage in megabytes. If storage exceeds this, oldest daily folders are removed until under budget. Defaults to ${defaultMaxMb} MB.`,
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, calculates and reports what would be removed without actually deleting files.',
        },
        path: {
          type: 'string',
          description: 'Optional custom artifact root directory to clean.',
        },
      },
      async execute(args: {
        retention_days?: number
        max_mb?: number
        dry_run?: boolean
        path?: string
      }): Promise<string> {
        const targetRoot = args.path || root
        const retentionDays = args.retention_days ?? defaultRetention
        const maxMb = args.max_mb ?? defaultMaxMb
        const maxBytes = maxMb * 1024 * 1024
        const dryRun = args.dry_run === true

        const res = await sweepArtifacts({
          root: targetRoot,
          retentionDays,
          maxBytes,
          dryRun,
        })

        const header = dryRun ? '[Dry Run] Simulated GC Cleanup:' : 'GC Cleanup Completed:'
        const lines = [
          header,
          `- Target root: ${targetRoot}`,
          `- Retention window: ${retentionDays} day(s)`,
          `- Max capacity limit: ${maxMb} MB`,
          `- Folders ${dryRun ? 'to delete' : 'deleted'}: ${res.deletedDates.length ? res.deletedDates.join(', ') : 'none'}`,
          `- Space ${dryRun ? 'to reclaim' : 'freed'}: ${formatBytes(res.freedBytes)} (${res.freedFiles} file(s))`,
          `- Remaining usage: ${formatBytes(res.remainingBytes)} across ${res.remainingFiles} file(s)`,
        ]

        return lines.join('\n')
      },
    },
  ]
}

export function apply(ctx: any, config: Config = {}) {
  const disabled = new Set(config.disable ?? [])

  // Register in Tool Ultra's catalog
  if (typeof ctx.inject === 'function') {
    ctx.inject(['toolCatalog'], (c: any) => {
      if (typeof c.toolCatalog?.registerToolPack !== 'function') return
      c.effect(() =>
        c.toolCatalog.registerToolPack({
          id: 'gc',
          title: 'Artifact Garbage Collection',
          summary: 'Date-partitioned storage management and LRU eviction for generated media, exports, and files.',
          source: '@lvy-jsd/dsh-tool-ultra-pack-gc',
          tools: TOOL_NAMES.filter((n) => !disabled.has(n)),
        }),
      )
    })
  }

  // Register tools
  for (const spec of createTools(config)) {
    if (disabled.has(spec.name)) continue
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => true,
        execute: (args: unknown) => spec.execute(args as any),
      } as any),
    )
  }

  // Optional background interval sweep
  const intervalMs = config.autoIntervalMs ?? DEFAULTS.autoIntervalMs
  if (intervalMs > 0 && typeof setInterval === 'function') {
    const timer = setInterval(() => {
      sweepArtifacts({
        root: config.artifactsDir || DEFAULT_ARTIFACTS_DIR,
        retentionDays: config.retentionDays ?? DEFAULTS.retentionDays,
        maxBytes: (config.maxMegabytes ?? DEFAULTS.maxMegabytes) * 1024 * 1024,
      }).catch((err) => {
        ctx.logger?.warn?.(`[tool-ultra-pack-gc] automated sweep error: ${err.message}`)
      })
    }, intervalMs)

    if (timer.unref) timer.unref()
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => clearInterval(timer))
    }
  }
}
