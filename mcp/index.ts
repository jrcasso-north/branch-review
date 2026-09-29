import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './server.js'

async function main(): Promise<void> {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
  // stdout carries JSON-RPC; diagnostics must go to stderr.
  console.error('branch-review MCP server running on stdio')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
