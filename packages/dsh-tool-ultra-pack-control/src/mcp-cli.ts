#!/usr/bin/env node
import { loadControlConfig } from './mcp-config.js'
import { serveMcpStdio } from './mcp.js'
import { redact } from './kit/policy.js'

try {
  const args = process.argv.slice(2)
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stderr.write('Usage: pack-control-mcp --config /absolute/path/to/control.yml\nRead-only MCP server over stdio; no DSH installation required.\n')
  } else {
    if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new Error('Usage: pack-control-mcp --config /absolute/path/to/control.yml')
    await serveMcpStdio(await loadControlConfig(args[1]))
  }
} catch (error) {
  process.stderr.write(`pack-control-mcp: ${redact(error instanceof Error ? error.message : String(error))}\n`)
  process.exitCode = 1
}
