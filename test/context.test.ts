import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { getCommitDiff } from '../server/git.js'
import { buildCommentContext, sliceHunk } from '../mcp/context.js'
import { formatDiffLines } from '../mcp/format.js'
import type { Comment } from '../server/schema.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

describe('comment context', () => {
  let fixture: Fixture

  before(async () => {
    fixture = await createFixtureRepo()
  })

  after(() => fixture.cleanup())

  function lineComment(overrides: Record<string, unknown> = {}): Comment {
    return {
      id: 'cmt_line',
      kind: 'line',
      commitSha: fixture.reviewSha,
      path: 'calc.js',
      line: 4,
      startLine: 3,
      lineType: 'added',
      body: 'Prefer reduce.',
      createdAt: new Date().toISOString(),
      ...overrides,
    } as Comment
  }

  test('slices the commented lines plus context', async () => {
    const files = await getCommitDiff(fixture.repoPath, fixture.reviewSha)
    const calc = files.find((f) => f.path === 'calc.js')
    assert.ok(calc)

    const hunk = sliceHunk(calc, lineComment() as Extract<Comment, { kind: 'line' }>, 2)
    assert.ok(hunk.length > 0)
    const covered = hunk.filter(
      (line) => line.newLine !== null && line.newLine >= 3 && line.newLine <= 4,
    )
    assert.equal(covered.length, 2)
  })

  test('contextLines=0 returns only the commented lines', async () => {
    const files = await getCommitDiff(fixture.repoPath, fixture.reviewSha)
    const calc = files.find((f) => f.path === 'calc.js')
    assert.ok(calc)

    const hunk = sliceHunk(calc, lineComment() as Extract<Comment, { kind: 'line' }>, 0)
    assert.equal(hunk.length, 2)
    assert.deepEqual(
      hunk.map((line) => line.newLine),
      [3, 4],
    )
  })

  test('builds context for a line comment', async () => {
    const context = await buildCommentContext(fixture.repoPath, lineComment(), 3)
    assert.equal(context.file?.path, 'calc.js')
    assert.ok(context.hunk.length >= 2)
    const rendered = formatDiffLines(context.hunk)
    assert.match(rendered, /sum = sum \+ item\.value/)
  })

  test('renders hunk headers verbatim and numbers the rest', async () => {
    const context = await buildCommentContext(fixture.repoPath, lineComment(), 12)
    const rendered = formatDiffLines(context.hunk)
    const lines = rendered.split('\n')

    const header = lines.find((line) => line.includes('@@'))
    assert.ok(header)
    assert.match(header, /^@@ -1,3 \+1,7 @@$/)

    const added = lines.find((line) => line.includes('sum = sum + item.value'))
    assert.ok(added)
    assert.match(added, /^\s+4 \+/)

    const removed = lines.find((line) => line.includes('return items.length'))
    assert.ok(removed)
    assert.match(removed, /^\s+2 -/)
  })

  test('file comments carry the file but no hunk', async () => {
    const context = await buildCommentContext(
      fixture.repoPath,
      lineComment({ kind: 'file', line: undefined, startLine: undefined, lineType: undefined }),
      3,
    )
    assert.equal(context.file?.path, 'calc.js')
    assert.deepEqual(context.hunk, [])
  })

  test('commit comments have no file context', async () => {
    const context = await buildCommentContext(
      fixture.repoPath,
      {
        id: 'cmt_commit',
        kind: 'commit',
        commitSha: fixture.reviewSha,
        body: 'Subject should say why.',
        createdAt: new Date().toISOString(),
      },
      3,
    )
    assert.equal(context.file, null)
    assert.deepEqual(context.hunk, [])
  })

  test('a commit that was rebased away reports itself, without throwing', async () => {
    const context = await buildCommentContext(
      fixture.repoPath,
      lineComment({ commitSha: '0'.repeat(40) }),
      3,
    )
    assert.equal(context.commitMissing, true)
    assert.equal(context.file, null)
    assert.deepEqual(context.hunk, [])
  })

  test('a stale path yields no file and no hunk', async () => {
    const context = await buildCommentContext(
      fixture.repoPath,
      lineComment({ path: 'deleted-since.js' }),
      3,
    )
    assert.equal(context.file, null)
    assert.deepEqual(context.hunk, [])
    assert.equal(context.commitMissing, false, 'the commit exists; only the path is stale')
  })
})
