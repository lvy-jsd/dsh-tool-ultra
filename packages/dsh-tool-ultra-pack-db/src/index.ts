/**
 * Tool Ultra Database pack: DuckDB integration.
 * In-memory OLAP analytics, zero-copy querying of CSV/Parquet files directly via SQL.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import duckdb from 'duckdb'

export const name = 'tool-ultra-pack-db'
export const inject = ['tools']

export interface Config {
  disable?: string[]
  maxRows?: number
  readOnly?: boolean
}

export const TOOL_NAMES = ['db_query', 'db_load_file'] as const

const DEFAULTS = {
  maxRows: 500,
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: String(value) }],
} as const

// Managed connection instance with auto-initialization and error boundaries
let instance: duckdb.Database | null = null

function getDatabase(): duckdb.Database {
  if (!instance) {
    instance = new duckdb.Database(':memory:')
  }
  return instance
}

/** Safely runs a query with connection lifecycle handling and truncation */
export async function runQuery(sql: string, maxRows = DEFAULTS.maxRows): Promise<string> {
  const db = getDatabase()
  const conn = db.connect()

  try {
    return await new Promise<string>((resolve, reject) => {
      conn.all(sql, (err: Error | null, rows: any[]) => {
        if (err) {
          return reject(new Error(`[DuckDB Execution Error] ${err.message}`))
        }
        if (!rows || rows.length === 0) {
          return resolve('Query returned 0 rows.')
        }

        const count = rows.length
        const truncated = count > maxRows ? rows.slice(0, maxRows) : rows
        const summary = count > maxRows ? `\n[Showing ${maxRows} of ${count} total rows]` : ''

        // Handle BigInt serialization from DuckDB aggregations safely
        const replacer = (_key: string, value: any) => (typeof value === 'bigint' ? Number(value) : value)
        resolve(JSON.stringify(truncated, replacer, 2) + summary)
      })
    })
  } finally {
    // Explicit handle cleanup to prevent resource leaks
    try {
      conn.close()
    } catch {
      // Ignore closing errors
    }
  }
}

export function createTools(config: Config = {}) {
  const maxRows = config.maxRows ?? DEFAULTS.maxRows

  return [
    {
      name: 'db_query' as const,
      description:
        'Execute analytical SQL queries in-memory using DuckDB. Supports ANSI SQL, aggregations, window functions, and directly querying files (e.g., SELECT * FROM "data.parquet" or read_csv_auto("file.csv")).',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'SQL statement to execute.',
        },
      },
      async execute(args: { query: string }): Promise<string> {
        if (!args.query || !args.query.trim()) {
          throw new Error('Query parameter cannot be empty.')
        }
        return await runQuery(args.query, maxRows)
      },
    },
    {
      name: 'db_load_file' as const,
      description:
        'Inspect, query, and describe a CSV or Parquet data file into DuckDB. Returns schema metadata, columns, types, and the first few sample rows without loading the whole file into context.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Local file path to a .csv, .parquet, or .json file.',
        },
      },
      async execute(args: { path: string }): Promise<string> {
        if (!args.path || !args.path.trim()) {
          throw new Error('File path cannot be empty.')
        }

        const sanitizedPath = args.path.replace(/'/g, "''")
        const ext = args.path.toLowerCase()

        let tableExpr = `'${sanitizedPath}'`
        if (ext.endsWith('.csv')) {
          tableExpr = `read_csv_auto('${sanitizedPath}')`
        } else if (ext.endsWith('.parquet')) {
          tableExpr = `read_parquet('${sanitizedPath}')`
        } else if (ext.endsWith('.json')) {
          tableExpr = `read_json_auto('${sanitizedPath}')`
        }

        const describeSql = `DESCRIBE SELECT * FROM ${tableExpr}`
        const sampleSql = `SELECT * FROM ${tableExpr} LIMIT 5`

        try {
          const schemaInfo = await runQuery(describeSql, 50)
          const sampleRows = await runQuery(sampleSql, 5)

          return [
            `File: ${args.path}`,
            'Schema:',
            schemaInfo,
            '',
            'Sample (First 5 Rows):',
            sampleRows,
          ].join('\n')
        } catch (err: any) {
          throw new Error(`[DuckDB File Load Error] Could not load or describe file "${args.path}": ${err.message}`)
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
          id: 'db',
          title: 'Database & Data Analysis',
          summary: 'In-memory DuckDB queries, fast Parquet/CSV scanning, and data aggregation.',
          source: '@lvy-jsd/dsh-tool-ultra-pack-db',
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
