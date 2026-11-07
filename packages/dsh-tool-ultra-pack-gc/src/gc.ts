/**
 * Tool Ultra Artifact GC Core:
 * Date-partitioned directory layout [YYYY-MM-DD] with age-based and LRU size-based eviction.
 */
import { readdir, stat, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_ARTIFACTS_DIR =
  process.env.SWIFTNEST_ARTIFACTS_DIR ||
  process.env.DSH_ARTIFACTS_DIR ||
  join(homedir(), 'dsh-artifacts')

export const DATE_DIR_REGEX = /^\d{4}-\d{2}-\d{2}$/

export interface DayStats {
  date: string
  path: string
  fileCount: number
  totalBytes: number
  mtimeMs: number
}

export interface ArtifactOverview {
  rootDir: string
  daysCount: number
  totalFiles: number
  totalBytes: number
  days: DayStats[]
}

export interface GcResult {
  dryRun: boolean
  freedBytes: number
  freedFiles: number
  deletedDates: string[]
  remainingBytes: number
  remainingFiles: number
}

/** Formats a Date object to YYYY-MM-DD in UTC or local timezone */
export function formatDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Returns the daily artifact path for a given date, ensuring it exists */
export async function getDailyArtifactDir(now = new Date(), root = DEFAULT_ARTIFACTS_DIR): Promise<string> {
  const dateStr = formatDate(now)
  const dir = join(root, dateStr)
  await mkdir(dir, { recursive: true })
  return dir
}

async function getDirSize(dirPath: string): Promise<{ bytes: number; count: number; newestMtime: number }> {
  let bytes = 0
  let count = 0
  let newestMtime = 0

  async function walk(current: string) {
    let entries: string[] = []
    try {
      entries = await readdir(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry)
      try {
        const s = await stat(full)
        if (s.isDirectory()) {
          await walk(full)
        } else if (s.isFile()) {
          bytes += s.size
          count += 1
          if (s.mtimeMs > newestMtime) newestMtime = s.mtimeMs
        }
      } catch {
        // file unlinked or inaccessible
      }
    }
  }

  await walk(dirPath)
  return { bytes, count, newestMtime }
}

/** Scans the root directory for all YYYY-MM-DD subdirectories */
export async function scanArtifacts(root = DEFAULT_ARTIFACTS_DIR): Promise<ArtifactOverview> {
  if (!existsSync(root)) {
    return { rootDir: root, daysCount: 0, totalFiles: 0, totalBytes: 0, days: [] }
  }

  const entries = await readdir(root, { withFileTypes: true })
  const days: DayStats[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && DATE_DIR_REGEX.test(entry.name)) {
      const dirPath = join(root, entry.name)
      const { bytes, count, newestMtime } = await getDirSize(dirPath)
      days.push({
        date: entry.name,
        path: dirPath,
        fileCount: count,
        totalBytes: bytes,
        mtimeMs: newestMtime,
      })
    }
  }

  // Sort chronological (oldest first)
  days.sort((a, b) => a.date.localeCompare(b.date))

  const totalFiles = days.reduce((acc, d) => acc + d.fileCount, 0)
  const totalBytes = days.reduce((acc, d) => acc + d.totalBytes, 0)

  return {
    rootDir: root,
    daysCount: days.length,
    totalFiles,
    totalBytes,
    days,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export interface SweepOptions {
  root?: string
  retentionDays?: number
  maxBytes?: number
  dryRun?: boolean
  referenceDate?: Date
}

/** Executes GC sweep removing expired date folders and enforcing capacity limits */
export async function sweepArtifacts(opts: SweepOptions = {}): Promise<GcResult> {
  const root = opts.root ?? DEFAULT_ARTIFACTS_DIR
  const retentionDays = opts.retentionDays ?? 7
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024 // 2 GB default
  const dryRun = opts.dryRun === true
  const now = opts.referenceDate ?? new Date()

  const overview = await scanArtifacts(root)
  let currentBytes = overview.totalBytes
  let currentFiles = overview.totalFiles

  let freedBytes = 0
  let freedFiles = 0
  const deletedDates: string[] = []

  // Cutoff calculation: keep dates >= cutoffStr
  const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  const cutoffStr = formatDate(new Date(cutoffTime))

  const remainingDays = [...overview.days]

  // Step 1: Remove days strictly older than retention cutoff
  for (let i = 0; i < remainingDays.length; ) {
    const day = remainingDays[i]!
    if (day.date < cutoffStr) {
      deletedDates.push(day.date)
      freedBytes += day.totalBytes
      freedFiles += day.fileCount
      currentBytes -= day.totalBytes
      currentFiles -= day.fileCount

      if (!dryRun) {
        await rm(day.path, { recursive: true, force: true })
      }
      remainingDays.splice(i, 1)
    } else {
      i++
    }
  }

  // Step 2: LRU capacity eviction if total remaining bytes > maxBytes
  // Evict oldest date first until within budget
  while (currentBytes > maxBytes && remainingDays.length > 0) {
    const oldest = remainingDays.shift()!
    deletedDates.push(oldest.date)
    freedBytes += oldest.totalBytes
    freedFiles += oldest.fileCount
    currentBytes -= oldest.totalBytes
    currentFiles -= oldest.fileCount

    if (!dryRun) {
      await rm(oldest.path, { recursive: true, force: true })
    }
  }

  return {
    dryRun,
    freedBytes,
    freedFiles,
    deletedDates,
    remainingBytes: currentBytes,
    remainingFiles: currentFiles,
  }
}
