import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { addComment, updateComments, writeConfig } from '../server/review-store.js'
import {
  createFixtureRepo,
  cursorFrom,
  startMcpSession,
  textOf,
  type Fixture,
  type McpSession,
} from './helpers.js'

describe('polling without a long-lived request', () => {
  let fixture: Fixture
  let session: McpSession

  before(async () => {
    fixture = await createFixtureRepo()
    await writeConfig(fixture.repoPath, { baseBranch: 'main', reviewBranch: 'feat/sum' })
    session = await startMcpSession(fixture.repoPath)
  })

  after(async () => {
    await session.close()
    await fixture.cleanup()
  })

  async function send(bodies: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const body of bodies) {
      const file = await addComment(fixture.repoPath, 'feat/sum', 'main', {
        kind: 'commit',
        commitSha: fixture.reviewSha,
        body,
      })
      ids.push(file.comments.at(-1)!.id)
    }
    await updateComments(fixture.repoPath, 'feat/sum', 'main', ids, { dispatched: true })
    return ids
  }

  function poll(args: Record<string, unknown> = {}) {
    return session.client.callTool({ name: 'poll_comments', arguments: args })
  }

  test('returns at once when there is nothing waiting', async () => {
    const body = textOf(await poll())
    assert.match(body, /Nothing new/)
  })

  test('returns what was sent, then nothing for the same cursor', async () => {
    await send(['Rename the helper.'])

    const first = textOf(await poll())
    assert.match(first, /1 comment\(s\) sent to the agent/)
    assert.match(first, /Rename the helper/)

    const cursor = cursorFrom(first)
    assert.ok(cursor, 'expected a nextCursor')

    const second = textOf(await poll({ cursor }))
    assert.match(second, /Nothing new/)
    assert.doesNotMatch(second, /Rename the helper/)
  })

  test('picks up only what arrived after the cursor', async () => {
    const cursor = cursorFrom(textOf(await poll()))
    await send(['Added after the cursor.'])

    const body = textOf(await poll({ cursor }))
    assert.match(body, /Added after the cursor/)
    assert.doesNotMatch(body, /Rename the helper/)
  })

  test('pages a bulk send and says how many are left', async () => {
    const start = cursorFrom(textOf(await poll()))
    await send(['Bulk one.', 'Bulk two.', 'Bulk three.'])

    const first = textOf(await poll({ cursor: start, limit: 2 }))
    assert.match(first, /2 comment\(s\) sent to the agent/)
    assert.match(first, /1 more waiting/)

    const rest = textOf(await poll({ cursor: cursorFrom(first), limit: 2 }))
    assert.match(rest, /1 comment\(s\) sent to the agent/)
    assert.doesNotMatch(rest, /more waiting/)
  })

  test('a cursor survives a reconnect, which a session set cannot', async () => {
    const cursor = cursorFrom(textOf(await poll()))
    await send(['Sent while the client was away.'])

    // A fresh process: anything held only in memory is gone.
    const reconnected = await startMcpSession(fixture.repoPath)
    try {
      const resumed = textOf(
        await reconnected.client.callTool({
          name: 'poll_comments',
          arguments: { cursor },
        }),
      )
      assert.match(resumed, /Sent while the client was away/)
      assert.doesNotMatch(resumed, /Bulk one/)

      const caughtUp = textOf(
        await reconnected.client.callTool({
          name: 'poll_comments',
          arguments: { cursor: cursorFrom(resumed) },
        }),
      )
      assert.match(caughtUp, /Nothing new/)
    } finally {
      await reconnected.close()
    }
  })

  test('watch_comments accepts the same cursor', async () => {
    const cursor = cursorFrom(textOf(await poll()))
    await send(['Seen by watch via cursor.'])

    const body = textOf(
      await session.client.callTool({
        name: 'watch_comments',
        arguments: { cursor, timeoutSeconds: 5 },
      }),
    )
    assert.match(body, /Seen by watch via cursor/)
    assert.match(body, /nextCursor: /)
  })
})
