import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { resolveRepo } from '../mcp/repo.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

describe('resolveRepo', () => {
  let fixture: Fixture
  /** macOS resolves /var to /private/var, and git reports the real path. */
  let repoRealPath: string

  before(async () => {
    fixture = await createFixtureRepo()
    repoRealPath = await realpath(fixture.repoPath)
  })

  after(() => fixture.cleanup())

  test('resolves an explicit repo path', async () => {
    assert.equal(await resolveRepo(fixture.repoPath), repoRealPath)
  })

  test('resolves the work tree root from a subdirectory', async () => {
    const nested = path.join(fixture.repoPath, 'src', 'deep')
    await mkdir(nested, { recursive: true })
    assert.equal(await resolveRepo(nested), repoRealPath)
  })

  test('explains what to do when the path is not a repo', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'branch-review-plain-'))
    try {
      await assert.rejects(
        () => resolveRepo(plain),
        (error: Error) => {
          assert.match(error.message, /Could not resolve a git repository/)
          assert.match(error.message, /Pass a repo argument/)
          assert.ok(error.message.includes(plain))
          return true
        },
      )
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  })
})
