import type { Comment } from './types'

/** Written by the reviewer, not yet sent to an agent, not yet resolved. */
export function sendableToAgent(comments: Comment[]): Comment[] {
  return comments.filter(
    (comment) => comment.resolved !== true && comment.dispatched !== true,
  )
}

export function sendableOnCommit(comments: Comment[], commitSha: string): Comment[] {
  return sendableToAgent(comments).filter((comment) => comment.commitSha === commitSha)
}
