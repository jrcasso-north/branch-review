import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { withFileLock } from './file-lock.js'
import { writeJsonAtomic } from './json-file.js'
import { queueFileSchema, type QueueFile, type QueueItem } from './queue-schema.js'

/**
 * The queue spans repositories, so unlike review comments it cannot live inside
 * one of them. `BRANCH_REVIEW_HOME` overrides the location for tests.
 */
export function queueRoot(): string {
  const override = process.env.BRANCH_REVIEW_HOME?.trim()
  return override ? path.resolve(override) : path.join(homedir(), '.branch-review')
}

function queuePath(): string {
  return path.join(queueRoot(), 'queue.json')
}

function lockPath(): string {
  return `${queuePath()}.lock`
}

function emptyQueue(): QueueFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: [],
    activeId: null,
  }
}

async function ensureQueueDir(): Promise<void> {
  await mkdir(queueRoot(), { recursive: true })
}

export async function readQueue(): Promise<QueueFile> {
  await ensureQueueDir()
  const target = queuePath()

  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyQueue()
    throw error
  }

  try {
    return queueFileSchema.parse(JSON.parse(raw))
  } catch (error) {
    const detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)
    throw Object.assign(
      new Error(
        `Could not read ${target}: ${detail}. Fix or move that file. ` +
          'Treating it as empty would discard the queue it holds.',
      ),
      { status: 500 },
    )
  }
}

async function writeQueue(file: QueueFile): Promise<QueueFile> {
  await ensureQueueDir()
  const parsed = queueFileSchema.parse({ ...file, updatedAt: new Date().toISOString() })
  await writeJsonAtomic(queuePath(), parsed)
  return parsed
}

/**
 * Read, change and write the queue under a lock. The UI, Claude and Codex all
 * write this one file, so the span has to be guarded across processes.
 */
export async function mutateQueue(
  mutate: (file: QueueFile) => void | Promise<void>,
): Promise<QueueFile> {
  await ensureQueueDir()
  return withFileLock(lockPath(), async () => {
    const file = await readQueue()
    await mutate(file)
    return writeQueue(file)
  })
}

export function findItem(file: QueueFile, id: string): QueueItem | undefined {
  return file.items.find((item) => item.id === id)
}

/** The next PR to review: the active one, else the first still queued. */
export function nextItem(file: QueueFile): QueueItem | undefined {
  const active = file.activeId === null ? undefined : findItem(file, file.activeId)
  if (active !== undefined && active.status !== 'done') return active
  return file.items.find((item) => item.status === 'queued' && item.error === undefined)
}
