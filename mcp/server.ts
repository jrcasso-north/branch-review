import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listCommitsNotInBase } from '../server/git.js'
import { readActiveReview, updateComment } from '../server/review-store.js'
import type { Comment } from '../server/schema.js'
import { buildCommentContext, DEFAULT_CONTEXT_LINES } from './context.js'
import {
  commentLocation,
  commentStatus,
  formatCommentList,
  formatDiffLines,
  shortSha,
} from './format.js'
import { resolveRepo } from './repo.js'
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  pendingForAgent,
  waitForDispatched,
} from './watch.js'

const repoArg = {
  repo: z
    .string()
    .optional()
    .describe('Path inside the repository. Defaults to the current working directory.'),
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  }
}

function findComment(comments: Comment[], id: string): Comment {
  const match = comments.find((comment) => comment.id === id)
  if (match === undefined) {
    throw new Error(`Comment not found: ${id}`)
  }
  return match
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'branch-review', version: '0.1.0' },
    {
      instructions: [
        'Read code-review comments left in the branch-review UI and apply them.',
        'Comments the reviewer sent to an agent have status "dispatched".',
        'Work one comment at a time: get_comment for the diff context, edit the',
        'code, then resolve_comment so the reviewer sees it is done.',
      ].join(' '),
    },
  )

  /** Ids already handed to this session, so watch_comments does not loop on them. */
  const seen = new Set<string>()

  server.registerTool(
    'get_review_status',
    {
      title: 'Get review status',
      description:
        'Branch under review, its base, the commits in range, and how many comments are open, dispatched, or resolved.',
      inputSchema: repoArg,
      annotations: { readOnlyHint: true },
    },
    async ({ repo }) => {
      try {
        const repoPath = await resolveRepo(repo)
        const { config, file } = await readActiveReview(repoPath)
        const commits = await listCommitsNotInBase(
          repoPath,
          config.baseBranch,
          config.reviewBranch,
        )
        const counts = { open: 0, dispatched: 0, resolved: 0 }
        for (const comment of file.comments) counts[commentStatus(comment)] += 1

        return text(
          [
            `repo: ${repoPath}`,
            `review branch: ${config.reviewBranch}`,
            `base branch: ${config.baseBranch}`,
            `commits in range: ${commits.length}`,
            `comments: ${counts.open} open, ${counts.dispatched} dispatched, ${counts.resolved} resolved`,
            '',
            'commits:',
            ...commits.map(
              (commit) => `  ${shortSha(commit.sha)} ${commit.subject}`,
            ),
          ].join('\n'),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'list_comments',
    {
      title: 'List review comments',
      description:
        'List review comments for the branch under review. Defaults to the comments the reviewer sent to an agent and has not resolved.',
      inputSchema: {
        ...repoArg,
        status: z
          .enum(['dispatched', 'open', 'resolved', 'all'])
          .optional()
          .describe('Which comments to return. Defaults to "dispatched".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, status = 'dispatched' }) => {
      try {
        const repoPath = await resolveRepo(repo)
        const { config, file } = await readActiveReview(repoPath)
        const selected =
          status === 'all'
            ? file.comments
            : status === 'dispatched'
              ? pendingForAgent(file.comments)
              : file.comments.filter((comment) => commentStatus(comment) === status)

        return text(
          [
            `${selected.length} ${status} comment(s) on ${config.reviewBranch}`,
            '',
            formatCommentList(selected, 'No comments match that filter.'),
          ].join('\n'),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'get_comment',
    {
      title: 'Get a review comment with its diff context',
      description:
        'Full text of one comment plus the diff around the lines it covers, so the change can be made in the right place.',
      inputSchema: {
        ...repoArg,
        commentId: z.string().min(1).describe('Comment id from list_comments.'),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe(`Diff lines to include on each side. Defaults to ${DEFAULT_CONTEXT_LINES}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, commentId, contextLines }) => {
      try {
        const repoPath = await resolveRepo(repo)
        const { file } = await readActiveReview(repoPath)
        const comment = findComment(file.comments, commentId)
        const context = await buildCommentContext(repoPath, comment, contextLines)

        const lines = [
          `id: ${comment.id}`,
          `status: ${commentStatus(comment)}`,
          `commit: ${comment.commitSha}`,
          `location: ${commentLocation(comment)}`,
          '',
          'comment:',
          comment.body,
        ]

        if (context.file !== null) {
          lines.push('', `file status: ${context.file.status}`)
          if (context.file.oldPath !== null) {
            lines.push(`renamed from: ${context.file.oldPath}`)
          }
        }
        if (context.hunk.length > 0) {
          lines.push('', 'diff context:', formatDiffLines(context.hunk))
        } else if (comment.kind === 'line') {
          lines.push(
            '',
            'Diff context unavailable. The commit may have been amended or rebased since the comment was written.',
          )
        }

        return text(lines.join('\n'))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'resolve_comment',
    {
      title: 'Resolve a review comment',
      description:
        'Mark a comment resolved once the change is made. The comment stays on disk and collapses in the UI. Pass resolved=false to reopen it.',
      inputSchema: {
        ...repoArg,
        commentId: z.string().min(1).describe('Comment id from list_comments.'),
        resolved: z
          .boolean()
          .optional()
          .describe('Defaults to true. Pass false to reopen the comment.'),
      },
    },
    async ({ repo, commentId, resolved = true }) => {
      try {
        const repoPath = await resolveRepo(repo)
        const { config, file } = await readActiveReview(repoPath)
        findComment(file.comments, commentId)
        const updated = await updateComment(
          repoPath,
          config.reviewBranch,
          config.baseBranch,
          commentId,
          { resolved },
        )
        const remaining = pendingForAgent(updated.comments).length

        return text(
          `Comment ${commentId} marked ${resolved ? 'resolved' : 'open'}. ${remaining} dispatched comment(s) still pending.`,
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'watch_comments',
    {
      title: 'Wait for the reviewer to send a comment',
      description:
        'Block until the reviewer sends a comment to the agent from the branch-review UI, then return the new comments. Returns an empty list when the timeout elapses; call it again to keep waiting.',
      inputSchema: {
        ...repoArg,
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .optional()
          .describe(`How long to wait. Defaults to ${DEFAULT_TIMEOUT_SECONDS}.`),
      },
      annotations: { readOnlyHint: true, idempotentHint: false },
    },
    async ({ repo, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS }, extra) => {
      try {
        const repoPath = await resolveRepo(repo)
        const fresh = await waitForDispatched({
          repoPath,
          timeoutMs: timeoutSeconds * 1000,
          seen,
          signal: extra?.signal,
        })

        if (fresh.length === 0) {
          return text(
            `No new comments within ${timeoutSeconds}s. Call watch_comments again to keep waiting.`,
          )
        }
        return text(
          [
            `${fresh.length} comment(s) sent to the agent:`,
            '',
            formatCommentList(fresh, ''),
            '',
            'Use get_comment for diff context, make the change, then resolve_comment.',
          ].join('\n'),
        )
      } catch (error) {
        return failure(error)
      }
    },
  )

  return server
}
