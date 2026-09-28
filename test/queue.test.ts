import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Comment } from '../server/schema.js'
import {
  clampLimit,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  positionOf,
  selectAfter,
  selectUnseen,
  sortByDispatch,
  takePage,
} from '../mcp/queue.js'

function comment(id: string, dispatchedAt?: string, extra: Partial<Comment> = {}): Comment {
  return {
    id,
    kind: 'commit',
    commitSha: 'abc123',
    body: `body ${id}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...(dispatchedAt ? { dispatched: true, dispatchedAt } : {}),
    ...extra,
  } as Comment
}

describe('queue ordering', () => {
  test('orders by when the reviewer sent it', () => {
    const ordered = sortByDispatch([
      comment('c', '2026-09-03T00:00:00.000Z'),
      comment('a', '2026-09-01T00:00:00.000Z'),
      comment('b', '2026-09-02T00:00:00.000Z'),
    ])
    assert.deepEqual(
      ordered.map((c) => c.id),
      ['a', 'b', 'c'],
    )
  })

  test('breaks ties by id, which a bulk send relies on', () => {
    const sameInstant = '2026-09-01T00:00:00.000Z'
    const ordered = sortByDispatch([
      comment('03', sameInstant),
      comment('01', sameInstant),
      comment('02', sameInstant),
    ])
    assert.deepEqual(
      ordered.map((c) => c.id),
      ['01', '02', '03'],
    )
  })
})

describe('selectAfter', () => {
  const sent = [
    comment('a', '2026-09-01T00:00:00.000Z'),
    comment('b', '2026-09-02T00:00:00.000Z'),
    comment('c', '2026-09-03T00:00:00.000Z'),
  ]

  test('no cursor returns everything waiting', () => {
    assert.equal(selectAfter(sent, undefined).length, 3)
    assert.equal(selectAfter(sent, '').length, 3)
  })

  test('a cursor returns only what came after it', () => {
    const after = selectAfter(sent, positionOf(sent[0]!))
    assert.deepEqual(
      after.map((c) => c.id),
      ['b', 'c'],
    )
  })

  test('the newest cursor returns nothing', () => {
    assert.deepEqual(selectAfter(sent, positionOf(sent[2]!)), [])
  })

  test('skips comments that were never sent, and resolved ones', () => {
    const mixed = [
      comment('a', '2026-09-01T00:00:00.000Z'),
      comment('b'),
      comment('c', '2026-09-03T00:00:00.000Z', { resolved: true }),
    ]
    assert.deepEqual(
      selectAfter(mixed, undefined).map((c) => c.id),
      ['a'],
    )
  })

  test('re-sending moves a comment past an old cursor', () => {
    const first = comment('a', '2026-09-01T00:00:00.000Z')
    const cursor = positionOf(first)
    assert.deepEqual(selectAfter([first], cursor), [])

    const resent = comment('a', '2026-09-05T00:00:00.000Z')
    assert.deepEqual(
      selectAfter([resent], cursor).map((c) => c.id),
      ['a'],
    )
  })
})

describe('selectUnseen', () => {
  test('excludes positions already handed over', () => {
    const sent = [
      comment('a', '2026-09-01T00:00:00.000Z'),
      comment('b', '2026-09-02T00:00:00.000Z'),
    ]
    const seen = new Set([positionOf(sent[0]!)])
    assert.deepEqual(
      selectUnseen(sent, seen).map((c) => c.id),
      ['b'],
    )
  })
})

describe('takePage', () => {
  const sent = [
    comment('a', '2026-09-01T00:00:00.000Z'),
    comment('b', '2026-09-02T00:00:00.000Z'),
    comment('c', '2026-09-03T00:00:00.000Z'),
  ]

  test('caps the page and reports what is left', () => {
    const page = takePage(sent, 2)
    assert.deepEqual(
      page.comments.map((c) => c.id),
      ['a', 'b'],
    )
    assert.equal(page.remaining, 1)
    assert.equal(page.nextCursor, positionOf(sent[1]!))
  })

  test('an empty page keeps the caller where it was', () => {
    const cursor = positionOf(sent[2]!)
    const page = takePage([], 10, cursor)
    assert.deepEqual(page.comments, [])
    assert.equal(page.remaining, 0)
    assert.equal(page.nextCursor, cursor)
  })

  test('an empty page with no cursor reports none', () => {
    assert.equal(takePage([], 10).nextCursor, null)
  })

  test('paging through with the returned cursor covers everything once', () => {
    const seenIds: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 5; i += 1) {
      const page = takePage(selectAfter(sent, cursor), 2, cursor)
      if (page.comments.length === 0) break
      seenIds.push(...page.comments.map((c) => c.id))
      cursor = page.nextCursor ?? cursor
    }
    assert.deepEqual(seenIds, ['a', 'b', 'c'])
  })
})

describe('clampLimit', () => {
  test('defaults and bounds', () => {
    assert.equal(clampLimit(undefined), DEFAULT_PAGE_LIMIT)
    assert.equal(clampLimit(5), 5)
    assert.equal(clampLimit(0), 1)
    assert.equal(clampLimit(9999), MAX_PAGE_LIMIT)
  })
})
