import { getCommitDiff, type DiffFile, type DiffLine } from '../server/git.js'
import type { Comment, LineType } from '../server/schema.js'

export const DEFAULT_CONTEXT_LINES = 12

export type CommentContext = {
  comment: Comment
  /** Diff for the commented file within its commit, or null when not found. */
  file: DiffFile | null
  /** Commented lines plus surrounding context; empty for file and commit comments. */
  hunk: DiffLine[]
}

function sideOf(lineType: LineType): 'old' | 'new' {
  return lineType === 'removed' ? 'old' : 'new'
}

function lineNumber(line: DiffLine, side: 'old' | 'new'): number | null {
  return side === 'old' ? line.oldLine : line.newLine
}

/**
 * Locate the commented lines inside the commit diff and widen the slice by
 * `contextLines` on both sides so the agent sees why the comment was made.
 */
export function sliceHunk(
  file: DiffFile,
  comment: Extract<Comment, { kind: 'line' }>,
  contextLines: number,
): DiffLine[] {
  const side = sideOf(comment.lineType)
  const start = comment.startLine ?? comment.line
  const covered: number[] = []

  file.lines.forEach((line, index) => {
    const number = lineNumber(line, side)
    if (number !== null && number >= start && number <= comment.line) {
      covered.push(index)
    }
  })

  const first = covered[0]
  const last = covered[covered.length - 1]
  if (first === undefined || last === undefined) return []

  const from = Math.max(0, first - contextLines)
  const to = Math.min(file.lines.length, last + contextLines + 1)
  return file.lines.slice(from, to)
}

export async function buildCommentContext(
  repoPath: string,
  comment: Comment,
  contextLines: number = DEFAULT_CONTEXT_LINES,
): Promise<CommentContext> {
  if (comment.kind === 'commit') {
    return { comment, file: null, hunk: [] }
  }

  const files = await getCommitDiff(repoPath, comment.commitSha)
  const file = files.find((candidate) => candidate.path === comment.path) ?? null
  if (file === null || comment.kind === 'file') {
    return { comment, file, hunk: [] }
  }

  return { comment, file, hunk: sliceHunk(file, comment, contextLines) }
}
