import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  activateQueueItem,
  advanceQueue,
  clearFinished,
  enqueuePullRequests,
  removeQueueItem,
} from '../server/queue-service.js'
import { readQueue } from '../server/queue-store.js'
import type { QueueItem } from '../server/queue-schema.js'
import { resolveRoots } from './roots.js'

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(error: unknown) {
  return {
    content: [
      { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
    ],
    isError: true,
  }
}

function describe(item: QueueItem, marker: string): string {
  const lines = [`${marker} ${item.id} [${item.status}]`]
  if (item.title !== undefined) {
    lines.push(`    ${item.title}${item.author === undefined ? '' : ` by ${item.author}`}`)
  }
  if (item.error !== undefined) {
    lines.push(`    cannot open: ${item.error}`)
  } else if (item.reviewBranch !== undefined) {
    lines.push(`    ${item.repoPath} (${item.reviewBranch} vs ${item.baseBranch})`)
  }
  return lines.join('\n')
}

function renderQueue(items: QueueItem[], activeId: string | null): string {
  if (items.length === 0) return 'The queue is empty.'
  return items
    .map((item) => describe(item, item.id === activeId ? '>' : ' '))
    .join('\n')
}

export function registerQueueTools(server: McpServer): void {
  server.registerTool(
    'enqueue_prs',
    {
      title: 'Add pull requests to the review queue',
      description:
        'Queue one or more GitHub pull requests for review. Accepts pasted URLs, one per line, or owner/repo#number shorthand. Each is matched to its local clone and its branch is fetched, so it is ready to open.',
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe('Pull request URLs, one per line. Extra prose is reported back, not silently dropped.'),
      },
    },
    async ({ text: input }) => {
      try {
        const roots = await resolveRoots()
        const result = await enqueuePullRequests(input, roots, 'agent')
        const lines = [`Queued ${result.added.length} pull request(s).`]
        if (result.alreadyQueued.length > 0) {
          lines.push(`Already queued: ${result.alreadyQueued.join(', ')}`)
        }
        for (const failed of result.failed) {
          lines.push(`Could not resolve ${failed.id}: ${failed.error}`)
        }
        if (result.skipped.length > 0) {
          lines.push(`Not pull request links: ${result.skipped.join(' | ')}`)
        }
        lines.push('', renderQueue(result.queue.items, result.queue.activeId))
        return text(lines.join('\n'))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'list_pr_queue',
    {
      title: 'List the review queue',
      description: 'Pull requests waiting to be reviewed, which one is open, and which are done.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const queue = await readQueue()
        const counts = { queued: 0, active: 0, done: 0 }
        for (const item of queue.items) counts[item.status] += 1
        return text(
          [
            `${counts.queued} queued, ${counts.active} open, ${counts.done} done`,
            '',
            renderQueue(queue.items, queue.activeId),
          ].join('\n'),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'open_pr',
    {
      title: 'Open a queued pull request',
      description:
        'Point branch-review at one queued pull request, setting its review and base branch so its commits can be reviewed.',
      inputSchema: {
        id: z.string().min(1).describe('Queue id, in the form owner/repo#number.'),
      },
    },
    async ({ id }) => {
      try {
        const { item } = await activateQueueItem(id)
        return text(`Opened ${item.id}.\n${describe(item, '>')}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'next_pr',
    {
      title: 'Finish the current pull request and open the next',
      description:
        'Mark the open pull request done and open the next one that is ready. Entries that could not be resolved are stepped over.',
      inputSchema: {},
    },
    async () => {
      try {
        const result = await advanceQueue()
        if (!('item' in result)) {
          return text('Nothing left in the queue.')
        }
        return text(`Opened ${result.item.id}.\n${describe(result.item, '>')}`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'remove_from_pr_queue',
    {
      title: 'Remove entries from the review queue',
      description:
        'Drop one pull request from the queue, or clear everything already marked done.',
      inputSchema: {
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Queue id to drop. Omit to clear every finished entry instead.'),
      },
    },
    async ({ id }) => {
      try {
        const queue = id === undefined ? await clearFinished() : await removeQueueItem(id)
        return text(
          [
            id === undefined ? 'Cleared finished entries.' : `Removed ${id}.`,
            '',
            renderQueue(queue.items, queue.activeId),
          ].join('\n'),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )
}
