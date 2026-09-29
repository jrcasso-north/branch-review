import type { Comment } from '../server/schema.js'
import type { DiffLine } from '../server/git.js'

export type CommentStatus = 'open' | 'dispatched' | 'resolved'

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function commentStatus(comment: Comment): CommentStatus {
  if (comment.resolved === true) return 'resolved'
  if (comment.dispatched === true) return 'dispatched'
  return 'open'
}

/** Human-readable anchor, e.g. `src/foo.ts:42-45 (added)`. */
export function commentLocation(comment: Comment): string {
  if (comment.kind === 'commit') {
    return `commit ${shortSha(comment.commitSha)} (whole commit)`
  }
  if (comment.kind === 'file') {
    return `${comment.path} (whole file)`
  }
  const range =
    comment.startLine !== undefined && comment.startLine !== comment.line
      ? `${comment.startLine}-${comment.line}`
      : String(comment.line)
  return `${comment.path}:${range} (${comment.lineType})`
}

function indentBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n')
}

export function formatComment(comment: Comment): string {
  return [
    `[${comment.id}] ${commentStatus(comment)} in ${shortSha(comment.commitSha)}`,
    `  at ${commentLocation(comment)}`,
    indentBody(comment.body),
  ].join('\n')
}

export function formatCommentList(comments: Comment[], emptyNote: string): string {
  if (comments.length === 0) return emptyNote
  return comments.map(formatComment).join('\n\n')
}

const MARKERS: Record<Exclude<DiffLine['type'], 'meta'>, string> = {
  added: '+',
  removed: '-',
  unchanged: ' ',
}

/**
 * Render diff lines with their post-image line numbers so an agent can map a
 * comment onto the working tree. Removed lines carry the pre-image number, and
 * hunk headers keep the form git already gave them.
 */
export function formatDiffLines(lines: DiffLine[]): string {
  return lines
    .map((line) => {
      if (line.type === 'meta') return line.content
      const number = line.newLine ?? line.oldLine
      const gutter = String(number ?? '').padStart(5, ' ')
      return `${gutter} ${MARKERS[line.type]}${line.content}`
    })
    .join('\n')
}
