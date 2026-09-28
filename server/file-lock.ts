import { open, rm, stat } from 'node:fs/promises'

const RETRY_MS = 20
const DEFAULT_TIMEOUT_MS = 5_000
/** A lock older than this is treated as abandoned by a process that died. */
const STALE_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function clearIfStale(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath)
    if (Date.now() - info.mtimeMs > STALE_MS) {
      await rm(lockPath, { force: true })
    }
  } catch {
    // Already gone; the next acquire settles it.
  }
}

/**
 * Hold an exclusive lock for the length of a read-modify-write. The web server
 * and the MCP server both write the review files, so the span has to be guarded
 * between processes and not only within one.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await clearIfStale(lockPath)
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the review lock at ${lockPath}`)
      }
      await sleep(RETRY_MS)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockPath, { force: true })
  }
}
