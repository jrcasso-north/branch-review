import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const execFileAsync = promisify(execFile)

const GIT_ENV = [
  '-c',
  'user.email=fixture@example.com',
  '-c',
  'user.name=Fixture',
  '-c',
  'commit.gpgsign=false',
]

export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...GIT_ENV, ...args])
  return stdout
}

export type Fixture = {
  repoPath: string
  reviewSha: string
  cleanup: () => Promise<void>
}

/**
 * Two-commit repo: `main` counts items, `feat/sum` adds them up. The review
 * commit touches one existing file and adds one new file.
 */
export async function createFixtureRepo(): Promise<Fixture> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'branch-review-test-'))

  await git(repoPath, ['init', '--quiet', '--initial-branch=main'])
  await writeFile(
    path.join(repoPath, 'calc.js'),
    'export function total(items) {\n  return items.length\n}\n',
    'utf8',
  )
  await git(repoPath, ['add', '-A'])
  await git(repoPath, ['commit', '--quiet', '-m', 'Add calc'])

  await git(repoPath, ['checkout', '--quiet', '-b', 'feat/sum'])
  await writeFile(
    path.join(repoPath, 'calc.js'),
    [
      'export function total(items) {',
      '  let sum = 0',
      '  for (const item of items) {',
      '    sum = sum + item.value',
      '  }',
      '  return sum',
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(path.join(repoPath, 'version.js'), 'export const VERSION = "1"\n', 'utf8')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, ['commit', '--quiet', '-m', 'Sum item values instead of counting'])

  const reviewSha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim()

  return {
    repoPath,
    reviewSha,
    cleanup: () => rm(repoPath, { recursive: true, force: true }),
  }
}

export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/** Read `nextCursor: <value>` out of a tool's text response. */
export function cursorFrom(body: string): string | undefined {
  return /^nextCursor: (.+)$/m.exec(body)?.[1]
}

export type McpSession = {
  client: Client
  close: () => Promise<void>
}

/** Start the MCP server the way a client would, as its own process. */
export async function startMcpSession(repoPath: string): Promise<McpSession> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
      path.join(repoRoot, 'mcp/index.ts'),
    ],
    cwd: repoRoot,
    env: {
      ...(process.env as Record<string, string>),
      BRANCH_REVIEW_REPO: repoPath,
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'branch-review-test', version: '0.0.0' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}
