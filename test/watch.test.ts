import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { addComment, updateComment, writeConfig } from '../server/review-store.js'
import type { Comment } from '../server/schema.js'
import { pendingForAgent, waitForDispatched } from '../mcp/watch.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'cmt_1',
    kind: 'commit',
    commitSha: 'abc123',
    body: 'Say why, not what.',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Comment
}

describe('pendingForAgent', () => {
  test('keeps dispatched and unresolved comments', () => {
    const wanted = comment({ id: 'a', dispatched: true })
    const result = pendingForAgent([
      wanted,
      comment({ id: 'b' }),
      comment({ id: 'c', dispatched: true, resolved: true }),
      comment({ id: 'd', resolved: true }),
    ])
    assert.deepEqual(
      result.map((c) => c.id),
      ['a'],
    )
  })

  test('returns nothing for an empty review', () => {
    assert.deepEqual(pendingForAgent([]), [])
  })
})

describe('waitForDispatched', () => {
  let fixture: Fixture

  before(async () => {
    fixture = await createFixtureRepo()
    await writeConfig(fixture.repoPath, { baseBranch: 'main', reviewBranch: 'feat/sum' })
  })

  after(() => fixture.cleanup())

  async function seedDispatched(body: string): Promise<string> {
    const file = await addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind: 'commit',
      commitSha: fixture.reviewSha,
      body,
    })
    const created = file.comments.at(-1)
    assert.ok(created)
    await updateComment(fixture.repoPath, 'feat/sum', 'main', created.id, {
      dispatched: true,
    })
    return created.id
  }

  test('returns an already dispatched comment without waiting', async () => {
    const id = await seedDispatched('Fix the subject line.')
    const found = await waitForDispatched({
      repoPath: fixture.repoPath,
      timeoutMs: 5_000,
      seen: new Set(),
    })
    assert.deepEqual(
      found.map((c) => c.id),
      [id],
    )
  })

  test('does not return the same comment twice in one session', async () => {
    const id = await seedDispatched('Split this commit.')
    const seen = new Set<string>()
    const first = await waitForDispatched({
      repoPath: fixture.repoPath,
      timeoutMs: 5_000,
      seen,
    })
    assert.ok(first.some((c) => c.id === id))
    assert.ok(seen.has(id))

    const second = await waitForDispatched({
      repoPath: fixture.repoPath,
      timeoutMs: 50,
      seen,
    })
    assert.deepEqual(second, [])
  })

  test('returns empty once the timeout elapses', async () => {
    const seen = new Set<string>()
    await waitForDispatched({ repoPath: fixture.repoPath, timeoutMs: 5_000, seen })
    const started = Date.now()
    const found = await waitForDispatched({
      repoPath: fixture.repoPath,
      timeoutMs: 300,
      seen,
    })
    assert.deepEqual(found, [])
    assert.ok(Date.now() - started >= 250)
  })

  test('aborts when the caller cancels', async () => {
    const controller = new AbortController()
    const seen = new Set<string>()
    await waitForDispatched({ repoPath: fixture.repoPath, timeoutMs: 5_000, seen })
    const pending = waitForDispatched({
      repoPath: fixture.repoPath,
      timeoutMs: 10_000,
      seen,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(new Error('cancelled')), 50)
    await assert.rejects(() => pending, /cancelled/)
  })
})
