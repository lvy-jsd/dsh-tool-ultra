#!/usr/bin/env node
// A process fixture, never a shell or a real network connection.
const { writeFileSync } = require('node:fs')
function fakeSsh(argv, input) {
  const command = argv.at(-1)
  if (!argv.includes('reader@server.example.com') || !command?.includes('/srv/example.txt') || !command.includes('dd if=') || input !== '') {
    throw new Error('Unexpected fake SSH invocation')
  }
  return 'hello from fake SSH\n'
}
module.exports = { fakeSsh }
if (require.main === module) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    const argv = process.argv.slice(2)
    try {
      const output = fakeSsh(argv, input)
      writeFileSync(process.env.CONTROL_MCP_FAKE_SSH_LOG, JSON.stringify({ argv, stdin: input }))
      process.stdout.write(output)
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  })
}
