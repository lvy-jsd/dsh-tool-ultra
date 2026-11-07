// Office pack unit tests: Word, Excel read/write, PDF inspection, and unified error handling.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import {
  createTools,
  apply,
  TOOL_NAMES,
} from '../../packages/dsh-tool-ultra-pack-office/lib/index.js'

test('office: every tool is declared in package.json toolCatalog', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../packages/dsh-tool-ultra-pack-office/package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dsh.toolCatalog.tools).sort(), [...TOOL_NAMES].sort())
  assert.deepEqual(createTools().map((t) => t.name).sort(), [...TOOL_NAMES].sort())
})

test('office: apply registers tools minus disabled ones', () => {
  const registered = []
  apply({ tools: { register: (d) => registered.push(d.name ?? d.schema?.name) } }, { disable: ['office_pdf_info'] })
  assert.equal(registered.length, TOOL_NAMES.length - 1)
  assert.ok(!registered.includes('office_pdf_info'))
})

test('office: excel spreadsheet write and read roundtrip', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'office-test-'))
  try {
    const excelPath = join(temp, 'budget.xlsx')
    const tools = createTools()
    const writeTool = tools.find((t) => t.name === 'office_sheet_write')
    const readTool = tools.find((t) => t.name === 'office_sheet_read')

    const cols = JSON.stringify(['Item', 'Cost', 'Department'])
    const rows = JSON.stringify([
      ['Cloud Server', 1200, 'Infra'],
      ['Domain Names', 45, 'Marketing'],
      ['SSL Certs', 0, 'Security'],
    ])

    // Write excel
    const writeRes = await writeTool.execute({
      path: excelPath,
      sheet_name: 'Q4 Budget',
      columns: cols,
      rows,
    })
    assert.match(writeRes, /Spreadsheet successfully written/)

    // Read excel back
    const readRes = await readTool.execute({ path: excelPath })
    assert.match(readRes, /Sheet: "Q4 Budget"/)
    assert.match(readRes, /Cloud Server/)
    assert.match(readRes, /1200/)
    assert.match(readRes, /Marketing/)

    // Error handling on non-existent file
    await assert.rejects(
      readTool.execute({ path: join(temp, 'nonexistent.xlsx') }),
      /\[Office Spreadsheet Error\] File not found/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('office: pdf info inspection and error handling', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pdf-test-'))
  try {
    const pdfPath = join(temp, 'sample.pdf')
    const pdfDoc = await PDFDocument.create()
    pdfDoc.setTitle('Annual Report 2026')
    pdfDoc.setAuthor('Swiftnest Engineering')
    pdfDoc.addPage([600, 400])
    const bytes = await pdfDoc.save()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(pdfPath, bytes)

    const tools = createTools()
    const pdfTool = tools.find((t) => t.name === 'office_pdf_info')

    const info = await pdfTool.execute({ path: pdfPath })
    assert.match(info, /- Pages: 1/)
    assert.match(info, /- Title: Annual Report 2026/)
    assert.match(info, /- Author: Swiftnest Engineering/)

    // Error handling on non-existent file
    await assert.rejects(
      pdfTool.execute({ path: join(temp, 'not-found.pdf') }),
      /\[Office PDF Error\] File not found/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
