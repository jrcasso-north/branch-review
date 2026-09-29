import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parsePullRequestLine, parsePullRequestList, refId } from '../server/pr-url.js'
import { ownerRepoFromRemote, reviewBranchFor } from '../server/pr-resolve.js'

describe('parsePullRequestLine', () => {
  test('reads a pull request url', () => {
    const ref = parsePullRequestLine('https://github.com/north-app/north-anomalies/pull/36')
    assert.deepEqual(ref, {
      owner: 'north-app',
      repo: 'north-anomalies',
      number: 36,
      url: 'https://github.com/north-app/north-anomalies/pull/36',
    })
  })

  test('tolerates trailing paths, queries and fragments', () => {
    for (const suffix of ['/files', '?w=1', '#discussion_r1', '/commits/abc123']) {
      const ref = parsePullRequestLine(
        `https://github.com/north-app/north-accounts/pull/211${suffix}`,
      )
      assert.equal(ref?.number, 211, suffix)
    }
  })

  test('tolerates list markers and surrounding space', () => {
    for (const line of [
      '  https://github.com/o/r/pull/7  ',
      '- https://github.com/o/r/pull/7',
      '* https://github.com/o/r/pull/7',
      '> https://github.com/o/r/pull/7',
    ]) {
      assert.equal(parsePullRequestLine(line)?.number, 7, line)
    }
  })

  test('accepts owner/repo#number shorthand and canonicalises the url', () => {
    const ref = parsePullRequestLine('north-app/north-budget#12')
    assert.equal(ref?.url, 'https://github.com/north-app/north-budget/pull/12')
  })

  test('rejects things that are not pull requests', () => {
    for (const line of [
      'https://github.com/north-app/north-anomalies/issues/36',
      'https://github.com/north-app/north-anomalies',
      'https://gitlab.com/o/r/pull/1',
      'just some prose',
      'https://github.com/o/r/pull/abc',
      'https://github.com/o/r/pull/0',
    ]) {
      assert.equal(parsePullRequestLine(line), null, line)
    }
  })
})

describe('parsePullRequestList', () => {
  const pasted = `
    https://github.com/north-app/north-anomalies/pull/36
    https://github.com/north-app/north-authorizer/pull/122
    https://github.com/north-app/north-accounts/pull/211
  `

  test('reads every line of a pasted block', () => {
    const { refs, skipped } = parsePullRequestList(pasted)
    assert.deepEqual(refs.map(refId), [
      'north-app/north-anomalies#36',
      'north-app/north-authorizer#122',
      'north-app/north-accounts#211',
    ])
    assert.deepEqual(skipped, [])
  })

  test('keeps order and drops repeats', () => {
    const { refs } = parsePullRequestList(
      'https://github.com/o/r/pull/2\nhttps://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2',
    )
    assert.deepEqual(
      refs.map((r) => r.number),
      [2, 1],
    )
  })

  test('reports unparseable lines rather than dropping them silently', () => {
    const { refs, skipped } = parsePullRequestList(
      'https://github.com/o/r/pull/1\nhttps://github.com/o/r/pul/2\n\n   \nnonsense',
    )
    assert.equal(refs.length, 1)
    assert.deepEqual(skipped, ['https://github.com/o/r/pul/2', 'nonsense'])
  })
})

describe('remote matching', () => {
  test('reads owner and repo from every remote form', () => {
    for (const url of [
      'git@github.com:north-app/north-anomalies.git',
      'https://github.com/north-app/north-anomalies.git',
      'https://github.com/north-app/north-anomalies',
      'ssh://git@github.com/north-app/north-anomalies.git',
    ]) {
      assert.deepEqual(ownerRepoFromRemote(url), {
        owner: 'north-app',
        repo: 'north-anomalies',
      }, url)
    }
  })

  test('ignores remotes that are not github', () => {
    assert.equal(ownerRepoFromRemote('https://gitlab.com/o/r.git'), null)
  })
})

describe('reviewBranchFor', () => {
  test('namespaces the branch so it cannot collide with real work', () => {
    assert.equal(reviewBranchFor(36), 'review/pr-36')
  })
})
