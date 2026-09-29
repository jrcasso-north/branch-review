import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { addComment, readComments, writeConfig } from '../server/review-store.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

describe('an unreadable comments file', () => {
  let fixture: Fixture
  let commentsFile: string

  before(async () => {
    fixture = await createFixtureRepo()
    await writeConfig(fixture.repoPath, { baseBranch: 'main', reviewBranch: 'feat/sum' })
    commentsFile = path.join(
      fixture.repoPath,
      '.branch-review',
      'comments',
      'feat--sum.json',
    )
  })

  after(() => fixture.cleanup())

  function add(body: string) {
    return addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind: 'commit',
      commitSha: fixture.reviewSha,
      body,
    })
  }

  test('a missing file still reads as an empty review', async () => {
    const file = await readComments(fixture.repoPath, 'never-reviewed', 'main')
    assert.deepEqual(file.comments, [])
    assert.equal(file.branch, 'never-reviewed')
  })

  test('refuses to read a file that fails the schema, instead of reporting none', async () => {
    await add('First real comment.')
    await add('Second real comment.')
    const good = await readFile(commentsFile, 'utf8')

    await writeFile(commentsFile, good.replace('"version": 1', '"version": 99'), 'utf8')
    await assert.rejects(
      () => readComments(fixture.repoPath, 'feat/sum', 'main'),
      /Could not read .*feat--sum\.json/,
    )

    await writeFile(commentsFile, good, 'utf8')
  })

  test('refuses to read malformed json', async () => {
    const good = await readFile(commentsFile, 'utf8')
    await writeFile(commentsFile, good.slice(0, good.length / 2), 'utf8')

    await assert.rejects(
      () => readComments(fixture.repoPath, 'feat/sum', 'main'),
      /Could not read/,
    )

    await writeFile(commentsFile, good, 'utf8')
  })

  test('a write over an unreadable file does not discard its comments', async () => {
    const good = await readFile(commentsFile, 'utf8')
    await writeFile(commentsFile, '{ this is not json', 'utf8')

    await assert.rejects(() => add('Written while corrupt.'), /Could not read/)

    const onDisk = await readFile(commentsFile, 'utf8')
    assert.equal(onDisk, '{ this is not json', 'the bad file should be left alone')

    await writeFile(commentsFile, good, 'utf8')
    const recovered = await readComments(fixture.repoPath, 'feat/sum', 'main')
    assert.deepEqual(
      recovered.comments.map((c) => c.body),
      ['First real comment.', 'Second real comment.'],
    )
  })
})
