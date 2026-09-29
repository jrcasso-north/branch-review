/// <reference lib="dom" />
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { getBranchDiff, getSnapshotDiff } from '../server/git.js'
import { addComment, updateComment, writeConfig } from '../server/review-store.js'
import { buildCommentContext } from '../mcp/context.js'
import { createCommentSchema } from '../server/schema.js'
import { buildViewUrl, parseViewUrl } from '../src/viewUrl.js'
import { createFixtureRepo, git, startMcpSession, textOf } from './helpers.js'

test('branch diff combines commits and excludes changes only on the base', async (t) => {
  const fixture = await createFixtureRepo()
  t.after(fixture.cleanup)
  const repo = fixture.repoPath
  const baseSha = (await git(repo, ['rev-parse', 'main'])).trim()
  await writeFile(path.join(repo, 'version.js'), 'export const VERSION = "2"\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'Bump version'])
  await git(repo, ['checkout', '--quiet', 'main'])
  await writeFile(path.join(repo, 'base-only.txt'), 'Base changes\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'Advance base'])

  const diff = await getBranchDiff(repo, 'main', 'feat/sum')
  assert.equal(diff.baseSha, baseSha)
  assert.deepEqual(
    diff.files.map((file) => file.path),
    ['calc.js', 'version.js'],
  )
  assert.ok(diff.files[0]!.lines.some((line) => line.content.includes('item.value')))
  assert.ok(diff.files[1]!.lines.some((line) => line.content.includes('"2"')))
  assert.deepEqual(await getSnapshotDiff(repo, diff.baseSha, diff.headSha), diff.files)
  assert.deepEqual((await getBranchDiff(repo, 'main', 'main')).files, [])
  await assert.rejects(getBranchDiff(repo, 'missing-branch', 'feat/sum'))
  await assert.rejects(getSnapshotDiff(repo, '--output=/tmp/invalid', diff.headSha))
})

test('branch comments keep their original context after the branch advances, including over MCP', async (t) => {
  const fixture = await createFixtureRepo()
  t.after(fixture.cleanup)
  const repo = fixture.repoPath
  await writeFile(path.join(repo, 'version.js'), 'export const VERSION = "2"\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'Bump version'])
  const diff = await getBranchDiff(repo, 'main', 'feat/sum')
  await writeConfig(repo, { baseBranch: 'main', reviewBranch: 'feat/sum' })
  const file = await addComment(repo, 'feat/sum', 'main', {
    kind: 'line',
    commitSha: diff.headSha,
    diffBaseSha: diff.baseSha,
    path: 'calc.js',
    line: 4,
    lineType: 'added',
    body: 'Use reduce here.',
  })
  const comment = file.comments[0]!
  assert.equal(comment.diffBaseSha, diff.baseSha)
  await updateComment(repo, 'feat/sum', 'main', comment.id, { dispatched: true })
  await writeFile(path.join(repo, 'calc.js'), 'export const total = () => 0\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--quiet', '-m', 'Change calculation'])
  const context = await buildCommentContext(repo, comment, 0)
  assert.equal(context.commitMissing, false)
  assert.equal(context.hunk[0]?.content, '    sum = sum + item.value')
  const session = await startMcpSession(repo)
  t.after(session.close)
  const result = textOf(
    await session.client.callTool({ name: 'get_comment', arguments: { commentId: comment.id } }),
  )
  assert.match(result, /sum = sum \+ item.value/)
  assert.match(result, /branch diff/)
})

test('branch comments validate their immutable base while accepting legacy comments', () => {
  const legacy = { kind: 'commit', commitSha: 'abc1234', body: 'Review this' }
  assert.equal(createCommentSchema.safeParse(legacy).success, true)
  assert.equal(createCommentSchema.safeParse({ ...legacy, diffBaseSha: 'main' }).success, false)
  assert.equal(
    createCommentSchema.safeParse({ ...legacy, diffBaseSha: 'a'.repeat(40) }).success,
    false,
  )
})

test('branch URLs preserve file selection without a commit', () => {
  const url = buildViewUrl({
    repoName: 'app',
    reviewBranch: 'feature/review',
    baseBranch: 'main',
    filePath: 'src/app.ts',
  })
  const [pathname, hash] = url.split('#')
  assert.ok(hash)
  assert.deepEqual(parseViewUrl(pathname, '#' + hash), {
    repoName: 'app',
    reviewBranch: 'feature/review',
    baseBranch: 'main',
    commitSha: null,
    filePath: 'src/app.ts',
  })
})

test('branch diffs preserve renamed and deleted files', async (t) => {
  const fixture = await createFixtureRepo()
  t.after(fixture.cleanup)
  const repo = fixture.repoPath
  await git(repo, ['mv', 'calc.js', 'renamed.js'])
  await git(repo, ['commit', '--quiet', '-m', 'Rename calculator'])
  const rename = await getBranchDiff(repo, fixture.reviewSha, 'feat/sum')
  assert.equal(rename.files[0]?.status, 'renamed')
  assert.equal(rename.files[0]?.path, 'renamed.js')
  assert.equal(rename.files[0]?.oldPath, 'calc.js')
  await git(repo, ['rm', 'renamed.js'])
  await git(repo, ['commit', '--quiet', '-m', 'Remove calculator'])
  const deletion = await getBranchDiff(repo, fixture.reviewSha, 'feat/sum')
  assert.equal(deletion.files[0]?.status, 'deleted')
  assert.equal(deletion.files[0]?.path, 'calc.js')
})

test('file and whole-branch comments retain their snapshot when read again', async (t) => {
  const fixture = await createFixtureRepo()
  t.after(fixture.cleanup)
  const snapshot = await getBranchDiff(fixture.repoPath, 'main', 'feat/sum')
  for (const kind of ['file', 'commit'] as const) {
    const file = await addComment(fixture.repoPath, 'feat/sum', 'main', {
      kind,
      commitSha: snapshot.headSha,
      diffBaseSha: snapshot.baseSha,
      path: 'calc.js',
      body: 'Check this change.',
    })
    const comment = file.comments.at(-1)!
    assert.equal(comment.diffBaseSha, snapshot.baseSha)
    const context = await buildCommentContext(fixture.repoPath, comment)
    assert.equal(context.commitMissing, false)
    assert.equal(context.file?.path ?? null, kind === 'file' ? 'calc.js' : null)
  }
})
