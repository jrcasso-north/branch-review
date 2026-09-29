import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createFixtureRepo, startMcpSession, textOf, type Fixture, type McpSession } from './helpers.js'

describe('review queue over MCP', () => {
  let fixture: Fixture
  let home: string
  let session: McpSession

  before(async () => {
    fixture = await createFixtureRepo()
    home = await mkdtemp(path.join(tmpdir(), 'branch-review-mcp-home-'))
    session = await startMcpSession(fixture.repoPath, {
      BRANCH_REVIEW_HOME: home,
      BRANCH_REVIEW_ROOTS: path.dirname(fixture.repoPath),
    })
  })

  after(async () => {
    await session.close()
    await rm(home, { recursive: true, force: true })
    await fixture.cleanup()
  })

  function call(name: string, args: Record<string, unknown> = {}) {
    return session.client.callTool({ name, arguments: args })
  }

  test('starts empty', async () => {
    assert.match(textOf(await call('list_pr_queue')), /The queue is empty/)
  })

  test('reports a repo it cannot find locally instead of failing the call', async () => {
    const body = textOf(
      await call('enqueue_prs', {
        text: 'https://github.com/nobody/definitely-not-cloned/pull/5',
      }),
    )
    assert.match(body, /Could not resolve nobody\/definitely-not-cloned#5/)
    assert.match(body, /No local clone/)
  })

  test('keeps the unresolvable entry visible in the queue', async () => {
    const body = textOf(await call('list_pr_queue'))
    assert.match(body, /nobody\/definitely-not-cloned#5/)
    assert.match(body, /cannot open/)
  })

  test('reports lines that are not pull request links', async () => {
    const body = textOf(await call('enqueue_prs', { text: 'just some prose' }))
    assert.match(body, /Not pull request links: just some prose/)
  })

  test('refuses to open an entry that could not be resolved', async () => {
    const result = await call('open_pr', { id: 'nobody/definitely-not-cloned#5' })
    assert.equal((result as { isError?: boolean }).isError, true)
    assert.match(textOf(result), /cannot be opened/)
  })

  test('next reports an empty queue rather than erroring', async () => {
    await call('remove_from_pr_queue', { id: 'nobody/definitely-not-cloned#5' })
    assert.match(textOf(await call('next_pr')), /Nothing left in the queue/)
  })
})
