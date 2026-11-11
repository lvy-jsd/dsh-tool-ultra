/**
 * Tool Ultra Office pack: Office Document handling.
 * Word (.docx), Excel (.xlsx), and PDF document reading and manipulation.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export const name = 'tool-ultra-pack-office'
export const inject = ['tools']

export interface Config {
  disable?: string[]
  maxChars?: number
  maxRows?: number
}

export const TOOL_NAMES = [
  'office_doc_read',
  'office_sheet_read',
  'office_sheet_write',
  'office_pdf_info',
] as const

const DEFAULTS = {
  maxChars: 30000,
  maxRows: 500,
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

export function createTools(config: Config = {}) {
  const maxChars = config.maxChars ?? DEFAULTS.maxChars
  const maxRows = config.maxRows ?? DEFAULTS.maxRows

  return [
    {
      name: 'office_doc_read' as const,
      description:
        'Extract text and structure from a Microsoft Word document (.docx). Returns clean Markdown/plain text representation.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the local .docx file.',
        },
      },
      async execute(args: { path: string }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('File path cannot be empty.')
        }
        if (!existsSync(args.path)) {
          throw new Error(`[Office Document Error] File not found: "${args.path}"`)
        }

        try {
          const result = await mammoth.extractRawText({ path: args.path })
          const text = result.value.trim()
          if (!text) {
            return `Document "${args.path}" was read successfully but contains no readable text.`
          }

          if (text.length > maxChars) {
            return `${text.slice(0, maxChars)}\n\n[Truncated: ${text.length - maxChars} additional characters omitted. Specify an offset or smaller range if needed.]`
          }
          return text
        } catch (e: any) {
          throw new Error(`[Office Document Error] Failed to read Word document "${args.path}": ${e.message}`)
        }
      },
    },
    {
      name: 'office_sheet_read' as const,
      description:
        'Read sheet data from an Excel spreadsheet (.xlsx). Returns rows as structured JSON or table rows.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the local .xlsx file.',
        },
        sheet: {
          type: 'string',
          description: 'Optional sheet name or 1-based index (e.g., "Sheet1" or "1"). Defaults to the first sheet.',
        },
      },
      async execute(args: { path: string; sheet?: string }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('File path cannot be empty.')
        }
        if (!existsSync(args.path)) {
          throw new Error(`[Office Spreadsheet Error] File not found: "${args.path}"`)
        }

        try {
          const workbook = new ExcelJS.Workbook()
          await workbook.xlsx.readFile(args.path)

          let worksheet: ExcelJS.Worksheet | undefined
          if (args.sheet) {
            const index = Number(args.sheet)
            if (!Number.isNaN(index) && index > 0) {
              worksheet = workbook.worksheets[index - 1]
            } else {
              worksheet = workbook.getWorksheet(args.sheet)
            }
          } else {
            worksheet = workbook.worksheets[0]
          }

          if (!worksheet) {
            const available = workbook.worksheets.map((s) => s.name).join(', ')
            throw new Error(`Sheet not found. Available sheets: [${available}]`)
          }

          const rows: any[] = []
          worksheet.eachRow((row: ExcelJS.Row, rowNumber: number) => {
            if (rows.length < maxRows) {
              // Convert row to plain array or object
              const values = Array.isArray(row.values) ? row.values.slice(1) : row.values
              rows.push({ row: rowNumber, values })
            }
          })

          const total = worksheet.rowCount
          const summary = total > maxRows ? `\n[Showing first ${maxRows} of ${total} total rows]` : ''
          return `Sheet: "${worksheet.name}" (Total Rows: ${total})\n` + JSON.stringify(rows, null, 2) + summary
        } catch (e: any) {
          throw new Error(`[Office Spreadsheet Error] Failed to read Excel file "${args.path}": ${e.message}`)
        }
      },
    },
    {
      name: 'office_sheet_write' as const,
      description:
        'Create a new Excel spreadsheet (.xlsx) with given column headers and row data.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Destination file path for the .xlsx file.',
        },
        sheet_name: {
          type: 'string',
          description: 'Optional name for the first sheet (defaults to "Sheet1").',
        },
        columns: {
          type: 'string',
          required: true,
          description: 'JSON array of column headers (e.g. ["Name", "Age", "Role"]).',
        },
        rows: {
          type: 'string',
          required: true,
          description: 'JSON array of row arrays or row objects.',
        },
      },
      async execute(args: { path: string; sheet_name?: string; columns: string; rows: string }): Promise<string> {
        let colsParsed: string[]
        let rowsParsed: any[]

        try {
          colsParsed = JSON.parse(args.columns)
          rowsParsed = JSON.parse(args.rows)
        } catch (err: any) {
          throw new Error(`[Office Spreadsheet Error] Failed to parse columns or rows JSON: ${err.message}`)
        }

        try {
          const workbook = new ExcelJS.Workbook()
          const sheet = workbook.addWorksheet(args.sheet_name || 'Sheet1')

          sheet.columns = colsParsed.map((header) => ({ header, key: header }))
          for (const row of rowsParsed) {
            sheet.addRow(row)
          }

          await workbook.xlsx.writeFile(args.path)
          return `Spreadsheet successfully written to "${args.path}" with ${rowsParsed.length} row(s).`
        } catch (e: any) {
          throw new Error(`[Office Spreadsheet Error] Failed to write Excel file "${args.path}": ${e.message}`)
        }
      },
    },
    {
      name: 'office_pdf_info' as const,
      description:
        'Read metadata, title, author, and page count from a PDF document.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the local .pdf file.',
        },
      },
      async execute(args: { path: string }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('File path cannot be empty.')
        }
        if (!existsSync(args.path)) {
          throw new Error(`[Office PDF Error] File not found: "${args.path}"`)
        }

        try {
          const bytes = await readFile(args.path)
          const pdfDoc = await PDFDocument.load(bytes)

          const pageCount = pdfDoc.getPageCount()
          const title = pdfDoc.getTitle() ?? '(none)'
          const author = pdfDoc.getAuthor() ?? '(none)'
          const subject = pdfDoc.getSubject() ?? '(none)'
          const creator = pdfDoc.getCreator() ?? '(none)'
          const producer = pdfDoc.getProducer() ?? '(none)'
          const creationDate = pdfDoc.getCreationDate()?.toISOString() ?? '(unknown)'

          return [
            `PDF Document: "${args.path}"`,
            `- Pages: ${pageCount}`,
            `- Title: ${title}`,
            `- Author: ${author}`,
            `- Subject: ${subject}`,
            `- Creator: ${creator}`,
            `- Producer: ${producer}`,
            `- Creation Date: ${creationDate}`,
          ].join('\n')
        } catch (e: any) {
          throw new Error(`[Office PDF Error] Failed to read PDF metadata from "${args.path}": ${e.message}`)
        }
      },
    },
  ]
}

export function apply(ctx: any, config: Config = {}) {
  const disabled = new Set(config.disable ?? [])

  if (typeof ctx.inject === 'function') {
    ctx.inject(['toolCatalog'], (c: any) => {
      if (typeof c.toolCatalog?.registerToolPack !== 'function') return
      c.effect(() =>
        c.toolCatalog.registerToolPack({
          id: 'office',
          title: 'Office Documents & PDF',
          summary: 'Word (.docx) text extraction, Excel (.xlsx) read/write, and PDF document metadata inspection.',
          source: '@lvy-jsd/dsh-tool-ultra-pack-office',
          tools: TOOL_NAMES.filter((n) => !disabled.has(n)),
        }),
      )
    })
  }

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
}
