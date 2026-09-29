import { readActiveReview } from '../server/review-store.js'
import type { Comment } from '../server/schema.js'
import { positionOf, selectAfter, selectUnseen } from './queue.js'

export const POLL_INTERVAL_MS = 500
export const DEFAULT_TIMEOUT_SECONDS = 120
export const MAX_TIMEOUT_SECONDS = 600

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
  /** Positions already returned to this session; used when no cursor is given. */
  seen: Set<string>
  /** Resume point from an earlier call. Unlike `seen`, it survives a reconnect. */
  cursor?: string
  signal?: AbortSignal
  now?: () => number
}

/**
 * Resolve as soon as the reviewer sends a comment to the agent. Returns an
 * empty array when the timeout elapses first, so the caller can ask again.
 */
export async function waitForDispatched({
  repoPath,
  timeoutMs,
  seen,
  cursor,
  signal,
  now = Date.now,
}: WaitOptions): Promise<Comment[]> {
  const deadline = now() + timeoutMs

  for (;;) {
    const { file } = await readActiveReview(repoPath)
    const fresh =
      cursor === undefined
        ? selectUnseen(file.comments, seen)
        : selectAfter(file.comments, cursor)

    if (fresh.length > 0) {
      for (const comment of fresh) seen.add(positionOf(comment))
      return fresh
    }

    const remaining = deadline - now()
    if (remaining <= 0) return []
    await sleep(Math.min(POLL_INTERVAL_MS, remaining), signal)
  }
}
