import type { Comment } from '../server/schema.js'

export const DEFAULT_PAGE_LIMIT = 20
export const MAX_PAGE_LIMIT = 100

const SEPARATOR = '|'

/** Comments the reviewer sent to an agent that are still not resolved. */
export function pendingForAgent(comments: Comment[]): Comment[] {
  return comments.filter(
    (comment) => comment.dispatched === true && comment.resolved !== true,
  )
}

/**
 * Sort key for one hand-off. `dispatchedAt` orders by when the reviewer sent
 * it; the id breaks ties, because sending a whole commit stamps every comment
 * in it at the same instant.
 */
export function positionOf(comment: Comment): string {
  return `${comment.dispatchedAt ?? ''}${SEPARATOR}${comment.id}`
}

export function sortByDispatch(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => {
    const left = positionOf(a)
    const right = positionOf(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** Hand-offs after `cursor`, oldest first. Undefined cursor means from the start. */
export function selectAfter(comments: Comment[], cursor?: string): Comment[] {
  const ordered = sortByDispatch(pendingForAgent(comments))
  if (cursor === undefined || cursor === '') return ordered
  return ordered.filter((comment) => positionOf(comment) > cursor)
}

/** Hand-offs this session has not returned yet, oldest first. */
export function selectUnseen(comments: Comment[], seen: Set<string>): Comment[] {
  return sortByDispatch(pendingForAgent(comments)).filter(
    (comment) => !seen.has(positionOf(comment)),
  )
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.max(limit, 1), MAX_PAGE_LIMIT)
}

export type QueuePage = {
  comments: Comment[]
  /** Pass back on the next call. Null only when nothing has ever been sent. */
  nextCursor: string | null
  /** Hand-offs left behind this page, so a caller knows to poll again at once. */
  remaining: number
}

/** Take the first `limit` hand-offs and report where the caller got to. */
export function takePage(
  selected: Comment[],
  limit: number,
  fallbackCursor?: string,
): QueuePage {
  const page = selected.slice(0, limit)
  const last = page[page.length - 1]
  return {
    comments: page,
    nextCursor: last ? positionOf(last) : (fallbackCursor ?? null),
    remaining: selected.length - page.length,
  }
}
