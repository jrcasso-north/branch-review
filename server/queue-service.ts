import { writeConfig } from './review-store.js'
import { parsePullRequestList, refId, type PullRequestRef } from './pr-url.js'
import { resolvePullRequest } from './pr-resolve.js'
import { mutateQueue, findItem, nextItem, readQueue } from './queue-store.js'
import type { QueueFile, QueueItem } from './queue-schema.js'

export type EnqueueResult = {
  queue: QueueFile
  added: string[]
  alreadyQueued: string[]
  failed: { id: string; error: string }[]
  skipped: string[]
}

async function buildItem(
  ref: PullRequestRef,
  roots: string[],
  addedBy: 'ui' | 'agent',
): Promise<QueueItem> {
  const base: QueueItem = {
    id: refId(ref),
    url: ref.url,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    status: 'queued',
    addedAt: new Date().toISOString(),
    addedBy,
  }

  try {
    const resolved = await resolvePullRequest(ref, roots)
    return {
      ...base,
      repoPath: resolved.repoPath,
      reviewBranch: resolved.reviewBranch,
      baseBranch: resolved.baseBranch,
      resolvedAt: new Date().toISOString(),
      ...(resolved.title === undefined ? {} : { title: resolved.title }),
      ...(resolved.author === undefined ? {} : { author: resolved.author }),
    }
  } catch (error) {
    // Keep the entry so the reviewer sees what failed and why.
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Add every pull request in a pasted block. Resolution runs per entry so one
 * repository that is not cloned locally cannot stop the rest being queued.
 */
export async function enqueuePullRequests(
  text: string,
  roots: string[],
  addedBy: 'ui' | 'agent' = 'ui',
): Promise<EnqueueResult> {
  const { refs, skipped } = parsePullRequestList(text)
  const existing = await readQueue()
  const known = new Set(existing.items.map((item) => item.id))

  const fresh = refs.filter((ref) => !known.has(refId(ref)))
  const alreadyQueued = refs.map(refId).filter((id) => known.has(id))

  const built = await Promise.all(fresh.map((ref) => buildItem(ref, roots, addedBy)))

  const queue = await mutateQueue((file) => {
    const present = new Set(file.items.map((item) => item.id))
    for (const item of built) {
      if (present.has(item.id)) continue
      file.items.push(item)
      present.add(item.id)
    }
  })

  return {
    queue,
    added: built.filter((item) => item.error === undefined).map((item) => item.id),
    alreadyQueued,
    failed: built
      .filter((item) => item.error !== undefined)
      .map((item) => ({ id: item.id, error: item.error as string })),
    skipped,
  }
}

function assertOpenable(item: QueueItem): asserts item is QueueItem & {
  repoPath: string
  reviewBranch: string
  baseBranch: string
} {
  if (item.error !== undefined) {
    throw Object.assign(new Error(`${item.id} cannot be opened: ${item.error}`), { status: 400 })
  }
  if (
    item.repoPath === undefined ||
    item.reviewBranch === undefined ||
    item.baseBranch === undefined
  ) {
    throw Object.assign(new Error(`${item.id} has not been resolved to a local clone`), {
      status: 400,
    })
  }
}

export type ActivationResult = {
  queue: QueueFile
  item: QueueItem
}

/**
 * Point the app at a queued pull request: write that repository's review config
 * so the UI opens on the right branches, and record it as the active entry.
 */
export async function activateQueueItem(id: string): Promise<ActivationResult> {
  const current = await readQueue()
  const target = findItem(current, id)
  if (target === undefined) {
    throw Object.assign(new Error(`Not in the queue: ${id}`), { status: 404 })
  }
  assertOpenable(target)

  await writeConfig(target.repoPath, {
    baseBranch: target.baseBranch,
    reviewBranch: target.reviewBranch,
  })

  const queue = await mutateQueue((file) => {
    for (const item of file.items) {
      if (item.id === id) {
        item.status = 'active'
      } else if (item.status === 'active') {
        item.status = 'queued'
      }
    }
    file.activeId = id
  })

  return { queue, item: findItem(queue, id) as QueueItem }
}

/**
 * Remember a compare branch against one queued pull request, so a choice made
 * while reviewing it is not carried over to the next one.
 */
export async function setQueueItemBase(id: string, baseBranch: string): Promise<QueueFile> {
  return mutateQueue((file) => {
    const item = findItem(file, id)
    if (item === undefined) {
      throw Object.assign(new Error(`Not in the queue: ${id}`), { status: 404 })
    }
    item.baseBranch = baseBranch
  })
}

export async function setQueueItemStatus(
  id: string,
  status: QueueItem['status'],
): Promise<QueueFile> {
  return mutateQueue((file) => {
    const item = findItem(file, id)
    if (item === undefined) {
      throw Object.assign(new Error(`Not in the queue: ${id}`), { status: 404 })
    }
    item.status = status
    if (status === 'done' && file.activeId === id) {
      file.activeId = null
    }
  })
}

export async function removeQueueItem(id: string): Promise<QueueFile> {
  return mutateQueue((file) => {
    file.items = file.items.filter((item) => item.id !== id)
    if (file.activeId === id) file.activeId = null
  })
}

export async function clearFinished(): Promise<QueueFile> {
  return mutateQueue((file) => {
    file.items = file.items.filter((item) => item.status !== 'done')
  })
}

/** Finish the current pull request and open the next one that is ready. */
export async function advanceQueue(): Promise<ActivationResult | { queue: QueueFile }> {
  const current = await readQueue()
  if (current.activeId !== null) {
    await setQueueItemStatus(current.activeId, 'done')
  }

  const afterDone = await readQueue()
  const upcoming = nextItem(afterDone)
  if (upcoming === undefined) {
    return { queue: afterDone }
  }
  return activateQueueItem(upcoming.id)
}
