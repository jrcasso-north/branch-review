import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { branchExists, fetchPullRequestHead, listBranches } from '../server/git.js'
import { resolvePullRequest } from '../server/pr-resolve.js'
import { createFixtureRepo, git } from './helpers.js'

test('existing PR branches retain local commits, index and working tree', async () => {
  const fixture = await createFixtureRepo()
  try {
    await git(fixture.repoPath, ['remote', 'add', 'origin', fixture.repoPath])
    await git(fixture.repoPath, ['update-ref', 'refs/pull/36/head', 'main'])
    await writeFile(path.join(fixture.repoPath, 'version.js'), 'staged\n')
    await git(fixture.repoPath, ['add', 'version.js'])
    await writeFile(path.join(fixture.repoPath, 'version.js'), 'unstaged\n')
    const before = await git(fixture.repoPath, ['diff', '--cached'])
    await fetchPullRequestHead(fixture.repoPath, 36, 'feat/sum')
    assert.equal((await git(fixture.repoPath, ['rev-parse', 'HEAD'])).trim(), fixture.reviewSha)
    assert.equal(await git(fixture.repoPath, ['diff', '--cached']), before)
    assert.equal(await readFile(path.join(fixture.repoPath, 'version.js'), 'utf8'), 'unstaged\n')
  } finally {
    await fixture.cleanup()
  }
})

test('missing PR branches use the real name without switching the checkout', async () => {
  const fixture = await createFixtureRepo()
  const clone = await mkdtemp(path.join(tmpdir(), 'branch-review-clone-'))
  try {
    await git(fixture.repoPath, ['update-ref', 'refs/pull/36/head', fixture.reviewSha])
    await git(clone, ['clone', '--quiet', fixture.repoPath, '.'])
    await fetchPullRequestHead(clone, 36, 'feature/real-pr')
    assert.equal((await git(clone, ['rev-parse', 'feature/real-pr'])).trim(), fixture.reviewSha)
    assert.equal((await git(clone, ['branch', '--show-current'])).trim(), 'feat/sum')
    assert.equal(await branchExists(clone, 'review/pr-36'), false)
    assert.equal(await branchExists(clone, 'origin/main'), true)
    assert.equal(await branchExists(clone, 'origin/main~1'), false)
    assert.ok((await listBranches(clone)).remote.includes('origin/main'))
    await assert.rejects(fetchPullRequestHead(clone, 36, 'bad:branch'))
  } finally {
    await fixture.cleanup()
    await rm(clone, { recursive: true, force: true })
  }
})

test('queue resolves GitHub head and remote base without replacing an existing branch', async () => {
  const fixture = await createFixtureRepo()
  const bin = await mkdtemp(path.join(tmpdir(), 'branch-review-gh-'))
  const oldPath = process.env.PATH
  try {
    await git(fixture.repoPath, ['remote', 'add', 'origin', 'https://github.com/o/r.git'])
    await git(fixture.repoPath, ['update-ref', 'refs/remotes/origin/main', 'main'])
    const gh = path.join(bin, 'gh')
    await writeFile(gh, '#!/bin/sh\nprintf \'%s\\n\' \'{"title":"Sum","headRefName":"feat/sum","baseRefName":"main"}\'\n')
    await chmod(gh, 0o700)
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`
    const ref = { owner: 'o', repo: 'r', number: 36, url: 'https://github.com/o/r/pull/36' }
    const resolved = await resolvePullRequest(ref, [fixture.repoPath])
    assert.equal(resolved.reviewBranch, 'feat/sum')
    assert.equal(resolved.baseBranch, 'origin/main')
    assert.deepEqual((await listBranches(fixture.repoPath)).local, ['feat/sum', 'main'])
    await writeFile(gh, '#!/bin/sh\nprintf \'%s\\n\' \'{}\'\n')
    await assert.rejects(resolvePullRequest(ref, [fixture.repoPath]), /branch metadata/)
  } finally {
    process.env.PATH = oldPath
    await fixture.cleanup()
    await rm(bin, { recursive: true, force: true })
  }
})
