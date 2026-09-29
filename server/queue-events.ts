import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { queueRoot } from './queue-store.js'

/** Collapse the burst of events a single write produces. */
const DEBOUNCE_MS = 120

/**
 * Call back whenever the queue file changes, whoever changed it: this server,
 * an MCP server in another process, or an editor.
 *
 * The directory is watched rather than the file itself, because writes land
 * through a rename and that replaces the inode a file watch holds on to.
 */
export function watchQueue(onChange: () => void): () => void {
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false

  function fire(): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, DEBOUNCE_MS)
  }

  void (async () => {
    const dir = queueRoot()
    await mkdir(dir, { recursive: true })
    if (closed) return
    watcher = watch(dir, (_event, filename) => {
      if (filename === null || path.basename(filename) === 'queue.json') fire()
    })
  })()

  return () => {
    closed = true
    if (timer !== null) clearTimeout(timer)
    watcher?.close()
    watcher = null
  }
}
