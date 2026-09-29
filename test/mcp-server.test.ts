import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { addComment, updateComment, writeConfig } from '../server/review-store.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

describe('branch-review MCP server', () => {
  let fixture: Fixture
  let client: Client
  let transport: StdioClientTransport
  let lineCommentId: string
  let commitCommentId: string

  before(async () => {
    fixture = await createFixtureRepo()
    await writeConfig(fixture.repoPath, { baseBranch: 'main', reviewBranch: 'feat/sum' })

    const withLine = await addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind: 'line',
      commitSha: fixture.reviewSha,
      path: 'calc.js',
      line: 4,
      startLine: 3,
      lineType: 'added',
      body: 'Prefer reduce over the manual accumulator.',
    })
    lineCommentId = withLine.comments.at(-1)!.id
    await updateComment(fixture.repoPath, 'feat/sum', 'main', lineCommentId, {
      dispatched: true,
    })

    const withCommit = await addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind: 'commit',
      commitSha: fixture.reviewSha,
      body: 'Subject should say why, not what.',
    })
    commitCommentId = withCommit.comments.at(-1)!.id

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
        path.join(repoRoot, 'mcp/index.ts'),
      ],
      cwd: repoRoot,
      env: {
        ...(process.env as Record<string, string>),
        BRANCH_REVIEW_REPO: fixture.repoPath,
      },
      stderr: 'pipe',
    })
    client = new Client({ name: 'branch-review-test', version: '0.0.0' })
    await client.connect(transport)
  })

  after(async () => {
    await client.close()
    await fixture.cleanup()
  })

  test('advertises the review tools', async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'get_comment',
        'get_review_status',
        'list_comments',
        'poll_comments',
        'resolve_comment',
        'watch_comments',
      ],
    )
  })

  test('get_review_status reports the branches and counts', async () => {
    const result = await client.callTool({ name: 'get_review_status', arguments: {} })
    const body = textOf(result)
    assert.match(body, /review branch: feat\/sum/)
    assert.match(body, /base branch: main/)
    assert.match(body, /commits in range: 1/)
    assert.match(body, /1 open, 1 dispatched, 0 resolved/)
    assert.match(body, /Sum item values instead of counting/)
  })

  test('list_comments defaults to dispatched comments', async () => {
    const result = await client.callTool({ name: 'list_comments', arguments: {} })
    const body = textOf(result)
    assert.match(body, /1 dispatched comment\(s\)/)
    assert.match(body, /Prefer reduce over the manual accumulator/)
    assert.doesNotMatch(body, /Subject should say why/)
  })

  test('list_comments can return every comment', async () => {
    const result = await client.callTool({
      name: 'list_comments',
      arguments: { status: 'all' },
    })
    const body = textOf(result)
    assert.match(body, /Prefer reduce over the manual accumulator/)
    assert.match(body, /Subject should say why/)
  })

  test('get_comment includes the diff context', async () => {
    const result = await client.callTool({
      name: 'get_comment',
      arguments: { commentId: lineCommentId },
    })
    const body = textOf(result)
    assert.match(body, /location: calc\.js:3-4 \(added\)/)
    assert.match(body, /sum = sum \+ item\.value/)
    assert.match(body, /file status: modified/)
  })

  test('get_comment reports an unknown id as an error', async () => {
    const result = await client.callTool({
      name: 'get_comment',
      arguments: { commentId: 'nope' },
    })
    assert.equal((result as { isError?: boolean }).isError, true)
    assert.match(textOf(result), /Comment not found: nope/)
  })

  test('resolve_comment marks the comment done', async () => {
    const result = await client.callTool({
      name: 'resolve_comment',
      arguments: { commentId: lineCommentId },
    })
    assert.match(textOf(result), /marked resolved\. 0 dispatched comment\(s\) still pending/)

    const listed = await client.callTool({ name: 'list_comments', arguments: {} })
    assert.match(textOf(listed), /0 dispatched comment\(s\)/)
  })

  test('watch_comments returns a comment the reviewer sends', async () => {
    const pending = client.callTool({
      name: 'watch_comments',
      arguments: { timeoutSeconds: 20 },
    })
    await updateComment(fixture.repoPath, 'feat/sum', 'main', commitCommentId, {
      dispatched: true,
    })
    const body = textOf(await pending)
    assert.match(body, /1 comment\(s\) sent to the agent/)
    assert.match(body, /Subject should say why, not what/)
  })

  test('watch_comments times out cleanly when nothing new arrives', async () => {
    const result = await client.callTool({
      name: 'watch_comments',
      arguments: { timeoutSeconds: 1 },
    })
    assert.match(textOf(result), /No new comments within 1s/)
  })
})
