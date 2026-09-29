import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  addComment,
  readActiveReview,
  updateComment,
  writeConfig,
} from '../server/review-store.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

describe('concurrent writers', () => {
  let fixture: Fixture

  before(async () => {
    fixture = await createFixtureRepo()
    await writeConfig(fixture.repoPath, { baseBranch: 'main', reviewBranch: 'feat/sum' })
  })

  after(() => fixture.cleanup())

  function add(body: string) {
    return addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind: 'commit',
      commitSha: fixture.reviewSha,
      body,
    })
  }

  test('parallel adds all survive', async () => {
    const bodies = Array.from({ length: 12 }, (_, i) => `Comment ${i}`)
    await Promise.all(bodies.map(add))

    const { file } = await readActiveReview(fixture.repoPath)
    const stored = file.comments.map((c) => c.body)
    for (const body of bodies) {
      assert.ok(stored.includes(body), `lost ${body}`)
    }
  })

  test('an update is not dropped by adds landing at the same time', async () => {
    const seeded = await add('Resolve me.')
    const id = seeded.comments.at(-1)!.id

    await Promise.all([
      add('Racer one.'),
      updateComment(fixture.repoPath, 'feat/sum', 'main', id, { resolved: true }),
      add('Racer two.'),
      updateComment(fixture.repoPath, 'feat/sum', 'main', id, { dispatched: true }),
    ])

    const { file } = await readActiveReview(fixture.repoPath)
    const stored = file.comments.map((c) => c.body)
    assert.ok(stored.includes('Racer one.'))
    assert.ok(stored.includes('Racer two.'))

    const target = file.comments.find((c) => c.id === id)
    assert.equal(target?.resolved, true, 'resolve was clobbered')
    assert.equal(target?.dispatched, true, 'dispatch was clobbered')
  })

  test('the file on disk is always complete json', async () => {
    const commentsFile = path.join(
      fixture.repoPath,
      '.branch-review',
      'comments',
      'feat--sum.json',
    )
    const writes = Promise.all(
      Array.from({ length: 10 }, (_, i) => add(`Torn read probe ${i}`)),
    )

    for (let i = 0; i < 40; i += 1) {
      try {
        JSON.parse(await readFile(commentsFile, 'utf8'))
      } catch (error) {
        assert.fail(`read a partial file: ${String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    await writes
  })

  test('the lock is released after a failed mutation', async () => {
    await assert.rejects(
      () => updateComment(fixture.repoPath, 'feat/sum', 'main', 'missing', { resolved: true }),
      /Comment not found/,
    )
    const after = await add('Still writable.')
    assert.ok(after.comments.some((c) => c.body === 'Still writable.'))
  })
})
