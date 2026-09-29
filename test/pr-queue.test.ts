import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { mutateQueue, nextItem, readQueue } from '../server/queue-store.js'
import {
  activateQueueItem,
  advanceQueue,
  clearFinished,
  enqueuePullRequests,
  removeQueueItem,
  setQueueItemStatus,
} from '../server/queue-service.js'
import type { QueueItem } from '../server/queue-schema.js'
import { createFixtureRepo, type Fixture } from './helpers.js'

let home: string
let fixture: Fixture

function item(overrides: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    url: `https://github.com/o/r/pull/1`,
    owner: 'o',
    repo: 'r',
    number: 1,
    status: 'queued',
    addedAt: new Date().toISOString(),
    addedBy: 'ui',
    ...overrides,
  } as QueueItem
}

async function seed(items: QueueItem[]): Promise<void> {
  await mutateQueue((file) => {
    file.items = items
    file.activeId = null
  })
}

describe('pr queue', () => {
  before(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'branch-review-home-'))
    process.env.BRANCH_REVIEW_HOME = home
    fixture = await createFixtureRepo()
  })

  after(async () => {
    delete process.env.BRANCH_REVIEW_HOME
    await rm(home, { recursive: true, force: true })
    await fixture.cleanup()
  })

  beforeEach(() => seed([]))

  test('an absent queue reads as empty rather than failing', async () => {
    const file = await readQueue()
    assert.deepEqual(file.items, [])
    assert.equal(file.activeId, null)
  })

  test('a repo with no local clone is queued with the reason, not dropped', async () => {
    const result = await enqueuePullRequests(
      'https://github.com/nobody/not-cloned-anywhere/pull/9',
      [fixture.repoPath],
    )
    assert.deepEqual(result.added, [])
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0]!.error, /No local clone/)

    const file = await readQueue()
    assert.equal(file.items.length, 1, 'the entry stays so the reviewer can see it')
    assert.match(file.items[0]!.error ?? '', /No local clone/)
  })

  test('unparseable lines are reported and the rest still queue', async () => {
    const result = await enqueuePullRequests(
      'not a link\nhttps://github.com/nobody/nope/pull/3',
      [fixture.repoPath],
    )
    assert.deepEqual(result.skipped, ['not a link'])
    assert.equal((await readQueue()).items.length, 1)
  })

  test('the same pull request is never queued twice', async () => {
    const url = 'https://github.com/nobody/nope/pull/4'
    await enqueuePullRequests(url, [fixture.repoPath])
    const second = await enqueuePullRequests(url, [fixture.repoPath])
    assert.deepEqual(second.alreadyQueued, ['nobody/nope#4'])
    assert.equal((await readQueue()).items.length, 1)
  })

  test('activating points the app at that repo and marks it active', async () => {
    await seed([
      item({
        id: 'o/r#1',
        repoPath: fixture.repoPath,
        reviewBranch: 'feat/sum',
        baseBranch: 'main',
      }),
    ])
    const { item: active } = await activateQueueItem('o/r#1')
    assert.equal(active.status, 'active')

    const { readConfig } = await import('../server/review-store.js')
    const config = await readConfig(fixture.repoPath)
    assert.deepEqual(config, { baseBranch: 'main', reviewBranch: 'feat/sum' })
    assert.equal((await readQueue()).activeId, 'o/r#1')
  })

  test('only one entry is active at a time', async () => {
    const common = { repoPath: fixture.repoPath, reviewBranch: 'feat/sum', baseBranch: 'main' }
    await seed([item({ id: 'o/r#1', ...common }), item({ id: 'o/r#2', ...common })])

    await activateQueueItem('o/r#1')
    await activateQueueItem('o/r#2')

    const file = await readQueue()
    assert.equal(file.activeId, 'o/r#2')
    assert.deepEqual(
      file.items.map((i) => i.status),
      ['queued', 'active'],
    )
  })

  test('an entry that failed to resolve cannot be opened', async () => {
    await seed([item({ id: 'o/r#1', error: 'No local clone of o/r' })])
    await assert.rejects(() => activateQueueItem('o/r#1'), /cannot be opened/)
  })

  test('next finishes the current one and opens the following one', async () => {
    const common = { repoPath: fixture.repoPath, reviewBranch: 'feat/sum', baseBranch: 'main' }
    await seed([item({ id: 'o/r#1', ...common }), item({ id: 'o/r#2', ...common })])
    await activateQueueItem('o/r#1')

    const result = await advanceQueue()
    assert.ok('item' in result)
    assert.equal(result.item.id, 'o/r#2')

    const file = await readQueue()
    assert.equal(file.items.find((i) => i.id === 'o/r#1')?.status, 'done')
    assert.equal(file.activeId, 'o/r#2')
  })

  test('next on the last entry finishes it and leaves nothing active', async () => {
    const common = { repoPath: fixture.repoPath, reviewBranch: 'feat/sum', baseBranch: 'main' }
    await seed([item({ id: 'o/r#1', ...common })])
    await activateQueueItem('o/r#1')

    const result = await advanceQueue()
    assert.ok(!('item' in result))
    const file = await readQueue()
    assert.equal(file.items[0]?.status, 'done')
    assert.equal(file.activeId, null)
  })

  test('next skips entries that cannot be opened', async () => {
    const common = { repoPath: fixture.repoPath, reviewBranch: 'feat/sum', baseBranch: 'main' }
    await seed([
      item({ id: 'o/r#1', ...common }),
      item({ id: 'o/r#2', error: 'No local clone of o/r' }),
      item({ id: 'o/r#3', ...common }),
    ])
    await activateQueueItem('o/r#1')

    const result = await advanceQueue()
    assert.ok('item' in result)
    assert.equal(result.item.id, 'o/r#3', 'the broken entry is stepped over, not opened')
  })

  test('nextItem prefers the entry already in progress', async () => {
    const common = { repoPath: fixture.repoPath, reviewBranch: 'feat/sum', baseBranch: 'main' }
    await seed([item({ id: 'o/r#1', ...common }), item({ id: 'o/r#2', ...common })])
    await activateQueueItem('o/r#2')
    assert.equal(nextItem(await readQueue())?.id, 'o/r#2')
  })

  test('removing the active entry clears the active marker', async () => {
    const common = { repoPath: fixture.repoPath, reviewBranch: 'feat/sum', baseBranch: 'main' }
    await seed([item({ id: 'o/r#1', ...common })])
    await activateQueueItem('o/r#1')
    const file = await removeQueueItem('o/r#1')
    assert.deepEqual(file.items, [])
    assert.equal(file.activeId, null)
  })

  test('clearing finished keeps everything still to do', async () => {
    await seed([
      item({ id: 'o/r#1', status: 'done' }),
      item({ id: 'o/r#2', status: 'queued' }),
    ])
    const file = await clearFinished()
    assert.deepEqual(
      file.items.map((i) => i.id),
      ['o/r#2'],
    )
  })

  test('status changes survive a reread', async () => {
    await seed([item({ id: 'o/r#1' })])
    await setQueueItemStatus('o/r#1', 'done')
    assert.equal((await readQueue()).items[0]?.status, 'done')
  })

  test('parallel adds do not lose entries', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        enqueuePullRequests(`https://github.com/nobody/nope/pull/${i + 1}`, [fixture.repoPath]),
      ),
    )
    assert.equal((await readQueue()).items.length, 8)
  })
})
