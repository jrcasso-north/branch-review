import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { watchQueue } from '../server/queue-events.js'
import { mutateQueue, readQueue } from '../server/queue-store.js'
import type { QueueItem } from '../server/queue-schema.js'

function entry(id: string): QueueItem {
  return {
    id,
    url: `https://github.com/o/r/pull/1`,
    owner: 'o',
    repo: 'r',
    number: 1,
    status: 'queued',
    addedAt: new Date().toISOString(),
    addedBy: 'agent',
  } as QueueItem
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Filesystem events from earlier writes can land just after a watch attaches. */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300))
}

describe('queue change notifications', () => {
  let home: string

  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'branch-review-events-'))
    process.env.BRANCH_REVIEW_HOME = home
    await mutateQueue((file) => {
      file.items = []
    })
  })

  after(async () => {
    delete process.env.BRANCH_REVIEW_HOME
    await rm(home, { recursive: true, force: true })
  })

  test('a write is noticed, including one from another process', async () => {
    let fired = 0
    const stop = watchQueue(() => {
      fired += 1
    })
    try {
      await drain()
      fired = 0

      await mutateQueue((file) => {
        file.items.push(entry('o/r#1'))
      })
      await waitFor(() => fired > 0, 5_000, 'the queue change to be noticed')
      assert.equal((await readQueue()).items.length, 1)
    } finally {
      stop()
    }
  })

  test('several writes in a row collapse into a notification', async () => {
    let fired = 0
    const stop = watchQueue(() => {
      fired += 1
    })
    try {
      await drain()
      fired = 0
      for (let i = 2; i <= 5; i += 1) {
        await mutateQueue((file) => {
          file.items.push(entry(`o/r#${i}`))
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.ok(fired >= 1, 'expected at least one notification')
      assert.ok(fired <= 5, `expected writes to be debounced, saw ${fired}`)
    } finally {
      stop()
    }
  })

  test('stopping detaches the watcher', async () => {
    let fired = 0
    const stop = watchQueue(() => {
      fired += 1
    })
    await drain()
    stop()
    fired = 0
    await mutateQueue((file) => {
      file.items.push(entry('o/r#99'))
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(fired, 0)
  })
})
