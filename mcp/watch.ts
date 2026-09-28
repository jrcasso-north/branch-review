import { readActiveReview } from '../server/review-store.js'
import type { Comment } from '../server/schema.js'

export const POLL_INTERVAL_MS = 500
export const DEFAULT_TIMEOUT_SECONDS = 120
export const MAX_TIMEOUT_SECONDS = 600

/** Comments the reviewer sent to an agent that are still not resolved. */
export function pendingForAgent(comments: Comment[]): Comment[] {
  return comments.filter(
    (comment) => comment.dispatched === true && comment.resolved !== true,
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type WaitOptions = {
  repoPath: string
  timeoutMs: number
  /** Comment ids already handed to this session; excluded from results. */
  seen: Set<string>
  signal?: AbortSignal
  now?: () => number
}

/**
 * Resolve as soon as the reviewer sends a comment to the agent. Returns an
 * empty array when the timeout elapses first, so the caller can poll again.
 */
export async function waitForDispatched({
  repoPath,
  timeoutMs,
  seen,
  signal,
  now = Date.now,
}: WaitOptions): Promise<Comment[]> {
  const deadline = now() + timeoutMs

  for (;;) {
    const { file } = await readActiveReview(repoPath)
    const fresh = pendingForAgent(file.comments).filter(
      (comment) => !seen.has(comment.id),
    )
    if (fresh.length > 0) {
      for (const comment of fresh) seen.add(comment.id)
      return fresh
    }

    const remaining = deadline - now()
    if (remaining <= 0) return []
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal)
  }
}
