import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  addComment,
  readActiveReview,
  updateComment,
  writeConfig,
} from '../server/review-store.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

describe('dispatch flag', () => {
  let fixture: Fixture

  before(async () => {
    fixture = await createFixtureRepo()
    await writeConfig(fixture.repoPath, { baseBranch: 'main', reviewBranch: 'feat/sum' })
  })

  after(() => fixture.cleanup())

  async function seedComment(body: string): Promise<string> {
    const file = await addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind: 'line',
      commitSha: fixture.reviewSha,
      path: 'calc.js',
      line: 4,
      startLine: 3,
      lineType: 'added',
      body,
    })
    const created = file.comments.at(-1)
    assert.ok(created)
    return created.id
  }

  test('new comments are not dispatched', async () => {
    const id = await seedComment('Prefer reduce here.')
    const { file } = await readActiveReview(fixture.repoPath)
    const comment = file.comments.find((c) => c.id === id)
    assert.equal(comment?.dispatched, undefined)
    assert.equal(comment?.dispatchedAt, undefined)
  })

  test('dispatching stamps dispatchedAt', async () => {
    const id = await seedComment('Name this variable.')
    const file = await updateComment(fixture.repoPath, 'feat/sum', 'main', id, {
      dispatched: true,
    })
    const comment = file.comments.find((c) => c.id === id)
    assert.equal(comment?.dispatched, true)
    assert.ok(comment?.dispatchedAt)
    assert.doesNotThrow(() => new Date(comment.dispatchedAt as string).toISOString())
  })

  test('undispatching clears both fields', async () => {
    const id = await seedComment('Drop this branch.')
    await updateComment(fixture.repoPath, 'feat/sum', 'main', id, { dispatched: true })
    const file = await updateComment(fixture.repoPath, 'feat/sum', 'main', id, {
      dispatched: false,
    })
    const comment = file.comments.find((c) => c.id === id)
    assert.equal(comment?.dispatched, undefined)
    assert.equal(comment?.dispatchedAt, undefined)
  })

  test('resolving keeps the dispatch record', async () => {
    const id = await seedComment('Extract a helper.')
    await updateComment(fixture.repoPath, 'feat/sum', 'main', id, { dispatched: true })
    const file = await updateComment(fixture.repoPath, 'feat/sum', 'main', id, {
      resolved: true,
    })
    const comment = file.comments.find((c) => c.id === id)
    assert.equal(comment?.resolved, true)
    assert.equal(comment?.dispatched, true)
  })

  test('readActiveReview rejects a repo with no config', async () => {
    const bare = await createFixtureRepo()
    try {
      await assert.rejects(() => readActiveReview(bare.repoPath), /No review configured/)
    } finally {
      await bare.cleanup()
    }
  })
})
