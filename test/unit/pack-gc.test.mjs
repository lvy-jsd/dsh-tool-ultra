// GC pack unit tests: date formatting, directory structure, scanning and eviction rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTools,
  apply,
  TOOL_NAMES,
  scanArtifacts,
  sweepArtifacts,
  getDailyArtifactDir,
} from '../../packages/dsh-tool-ultra-pack-gc/lib/index.js'

test('gc: every tool is declared in package.json toolCatalog', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-gc/package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dsh.toolCatalog.tools).sort(), [...TOOL_NAMES].sort())
  assert.deepEqual(createTools().map((t) => t.name).sort(), [...TOOL_NAMES].sort())
})

test('gc: apply registers tools minus disabled ones', () => {
  const registered = []
  apply({ tools: { register: (d) => registered.push(d.name ?? d.schema?.name) } }, { disable: ['gc_cleanup'] })
  assert.equal(registered.length, 1)
  assert.equal(registered[0], 'gc_status')
})

test('gc: date partition directory creation and scanning', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gc-test-'))
  try {
    const today = new Date('2026-11-07T12:00:00Z')
    const dailyDir = await getDailyArtifactDir(today, temp)
    assert.equal(dailyDir, join(temp, '2026-11-07'))

    await writeFile(join(dailyDir, 'output.png'), Buffer.alloc(1024))
    await writeFile(join(dailyDir, 'data.csv'), Buffer.alloc(2048))

    const overview = await scanArtifacts(temp)
    assert.equal(overview.daysCount, 1)
    assert.equal(overview.totalFiles, 2)
    assert.equal(overview.totalBytes, 3072)
    assert.equal(overview.days[0].date, '2026-11-07')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('gc: sweep respects retentionDays and size threshold', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gc-test-sweep-'))
  try {
    const day1 = join(temp, '2026-11-01')
    const day2 = join(temp, '2026-11-05')
    const day3 = join(temp, '2026-11-07')

    await mkdir(day1, { recursive: true })
    await mkdir(day2, { recursive: true })
    await mkdir(day3, { recursive: true })

    await writeFile(join(day1, 'old.bin'), Buffer.alloc(5000))
    await writeFile(join(day2, 'mid.bin'), Buffer.alloc(3000))
    await writeFile(join(day3, 'new.bin'), Buffer.alloc(2000))

    // 1. Dry run check
    const refDate = new Date('2026-11-07T12:00:00Z')
    const dry = await sweepArtifacts({
      root: temp,
      retentionDays: 3, // Cutoff: 2026-11-04. 2026-11-01 should be deleted
      referenceDate: refDate,
      dryRun: true,
    })
    assert.equal(dry.dryRun, true)
    assert.deepEqual(dry.deletedDates, ['2026-11-01'])
    assert.equal(dry.freedBytes, 5000)

    // Verify files still exist after dry run
    const pre = await scanArtifacts(temp)
    assert.equal(pre.daysCount, 3)

    // 2. Real sweep: age-based eviction
    const res = await sweepArtifacts({
      root: temp,
      retentionDays: 3,
      referenceDate: refDate,
      dryRun: false,
    })
    assert.deepEqual(res.deletedDates, ['2026-11-01'])
    assert.equal(res.freedBytes, 5000)
    assert.equal(res.remainingBytes, 5000)

    // 3. LRU capacity eviction (maxBytes: 2500 bytes, remaining is 5000 bytes)
    const capRes = await sweepArtifacts({
      root: temp,
      retentionDays: 10,
      maxBytes: 2500,
      referenceDate: refDate,
      dryRun: false,
    })
    // Oldest remaining (2026-11-05, 3000 bytes) evicted to bring total under 2500 bytes
    assert.deepEqual(capRes.deletedDates, ['2026-11-05'])
    assert.equal(capRes.freedBytes, 3000)
    assert.equal(capRes.remainingBytes, 2000)

    const finalState = await scanArtifacts(temp)
    assert.equal(finalState.daysCount, 1)
    assert.equal(finalState.days[0].date, '2026-11-07')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('gc: tool execution returns formatted user text', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'gc-test-tools-'))
  try {
    const today = new Date('2026-11-07T12:00:00Z')
    const daily = await getDailyArtifactDir(today, temp)
    await writeFile(join(daily, 'report.pdf'), Buffer.alloc(1024 * 1024))

    const tools = createTools({ artifactsDir: temp })
    const statusTool = tools.find((t) => t.name === 'gc_status')
    const cleanTool = tools.find((t) => t.name === 'gc_cleanup')

    const statusText = await statusTool.execute({})
    assert.match(statusText, /Total Size: 1\.0 MB across 1 file\(s\) in 1 day\(s\)/)
    assert.match(statusText, /\[2026-11-07\]: 1 file\(s\)/)

    const cleanText = await cleanTool.execute({ dry_run: true, retention_days: 1 })
    assert.match(cleanText, /\[Dry Run\] Simulated GC Cleanup/)
    assert.match(cleanText, /Remaining usage:/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
