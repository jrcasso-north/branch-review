import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import {
  commentsFileSchema,
  configSchema,
  createCommentSchema,
  storedConfigSchema,
  updateCommentSchema,
  setReviewedSchema,
  upsertMessageEditSchema,
  type Comment,
  type CommentsFile,
  type MessageEdit,
  type ReviewConfig,
} from './schema.js'

export type StoredConfig = {
  baseBranch: string
  reviewBranch?: string
}

const REVIEW_DIR = '.branch-review'
const GITIGNORE_CONTENTS = `*
`

export function branchSlug(branch: string): string {
  return branch.replace(/\//g, '--')
}

function reviewRoot(repoPath: string): string {
  return path.join(repoPath, REVIEW_DIR)
}

function configPath(repoPath: string): string {
  return path.join(reviewRoot(repoPath), 'config.json')
}

function commentsPath(repoPath: string, branch: string): string {
  return path.join(reviewRoot(repoPath), 'comments', `${branchSlug(branch)}.json`)
}

async function ensureReviewDir(repoPath: string): Promise<void> {
  const root = reviewRoot(repoPath)
  const commentsDir = path.join(root, 'comments')
  await mkdir(commentsDir, { recursive: true })
  const gitignorePath = path.join(root, '.gitignore')
  try {
    await access(gitignorePath)
  } catch {
    await writeFile(gitignorePath, GITIGNORE_CONTENTS, 'utf8')
  }
}

export async function readConfig(repoPath: string): Promise<StoredConfig | null> {
  try {
    const raw = await readFile(configPath(repoPath), 'utf8')
    return storedConfigSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function isConfigReady(config: StoredConfig | null): config is ReviewConfig {
  return Boolean(config?.baseBranch && config.reviewBranch)
}

export async function writeConfig(repoPath: string, config: ReviewConfig): Promise<ReviewConfig> {
  await ensureReviewDir(repoPath)
  const parsed = configSchema.parse(config)
  await writeFile(configPath(repoPath), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return parsed
}

function emptyCommentsFile(branch: string, baseBranch: string): CommentsFile {
  return {
    version: 1,
    branch,
    baseBranch,
    updatedAt: new Date().toISOString(),
    comments: [],
    messageEdits: {},
    reviewedShas: [],
  }
}

/**
 * Brief early draft stored `line` as the first line and `endLine` as the last.
 * Canonical form is GitHub-style: `line` = last (anchor), optional `startLine` = first.
 */
function migrateLegacyLineRange(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const file = raw as { comments?: unknown[] }
  if (!Array.isArray(file.comments)) return raw
  return {
    ...file,
    comments: file.comments.map((comment) => {
      if (!comment || typeof comment !== 'object') return comment
      const c = comment as Record<string, unknown>
      if (c.kind !== 'line') return comment
      if (typeof c.endLine !== 'number') return comment
      const endLine = c.endLine
      const { endLine: _drop, ...rest } = c
      if (typeof c.line === 'number' && c.startLine === undefined) {
        return {
          ...rest,
          ...(c.line !== endLine ? { startLine: c.line } : {}),
          line: endLine,
        }
      }
      return rest
    }),
  }
}

export async function readComments(
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<CommentsFile> {
  await ensureReviewDir(repoPath)
  try {
    const raw = await readFile(commentsPath(repoPath, branch), 'utf8')
    return commentsFileSchema.parse(migrateLegacyLineRange(JSON.parse(raw)))
  } catch {
    return emptyCommentsFile(branch, baseBranch)
  }
}

async function writeCommentsFile(repoPath: string, file: CommentsFile): Promise<CommentsFile> {
  await ensureReviewDir(repoPath)
  const parsed = commentsFileSchema.parse({
    ...file,
    updatedAt: new Date().toISOString(),
  })
  await writeFile(
    commentsPath(repoPath, parsed.branch),
    `${JSON.stringify(parsed, null, 2)}\n`,
    'utf8',
  )
  return parsed
}

function normalizeSnippet(snippet: string | undefined): string | undefined {
  if (snippet === undefined) return undefined
  if (snippet.trim() === '') return undefined
  return snippet
}

export async function addComment(
  repoPath: string,
  branch: string,
  baseBranch: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = createCommentSchema.parse(input)
  const file = await readComments(repoPath, branch, baseBranch)

  let comment: Comment
  if (data.kind === 'line') {
    comment = {
      id: ulid(),
      kind: 'line',
      commitSha: data.commitSha,
      path: data.path,
      line: data.line,
      lineType: data.lineType,
      body: data.body,
      createdAt: new Date().toISOString(),
    }
    if (data.startLine !== undefined && data.startLine !== data.line) {
      comment.startLine = data.startLine
    }
    const snippet = normalizeSnippet(data.snippet)
    if (snippet !== undefined) {
      comment.snippet = snippet
    }
  } else if (data.kind === 'file') {
    comment = {
      id: ulid(),
      kind: 'file',
      commitSha: data.commitSha,
      path: data.path,
      body: data.body,
      createdAt: new Date().toISOString(),
    }
  } else {
    comment = {
      id: ulid(),
      kind: 'commit',
      commitSha: data.commitSha,
      body: data.body,
      createdAt: new Date().toISOString(),
    }
  }

  file.baseBranch = baseBranch
  file.branch = branch
  file.comments.push(comment)
  return writeCommentsFile(repoPath, file)
}

export async function updateComment(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commentId: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = updateCommentSchema.parse(input)
  const file = await readComments(repoPath, branch, baseBranch)
  const index = file.comments.findIndex((c) => c.id === commentId)
  if (index === -1) {
    throw Object.assign(new Error(`Comment not found: ${commentId}`), { status: 404 })
  }
  const existing = file.comments[index]!
  const next: Comment = { ...existing }
  if (data.body !== undefined) {
    next.body = data.body
  }
  if (data.resolved !== undefined) {
    if (data.resolved) {
      next.resolved = true
      next.resolvedAt = new Date().toISOString()
    } else {
      delete next.resolved
      delete next.resolvedAt
    }
  }
  if (data.dispatched !== undefined) {
    if (data.dispatched) {
      next.dispatched = true
      next.dispatchedAt = new Date().toISOString()
    } else {
      delete next.dispatched
      delete next.dispatchedAt
    }
  }
  file.comments[index] = next
  file.baseBranch = baseBranch
  file.branch = branch
  return writeCommentsFile(repoPath, file)
}

export async function deleteComment(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commentId: string,
): Promise<CommentsFile> {
  const file = await readComments(repoPath, branch, baseBranch)
  file.comments = file.comments.filter((c) => c.id !== commentId)
  file.baseBranch = baseBranch
  file.branch = branch
  return writeCommentsFile(repoPath, file)
}

export async function upsertMessageEdit(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commitSha: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = upsertMessageEditSchema.parse(input)
  const file = await readComments(repoPath, branch, baseBranch)
  const edits = { ...(file.messageEdits ?? {}) }
  const current: MessageEdit = { ...(edits[commitSha] ?? {}) }

  if (data.subject === null) {
    delete current.subject
  } else if (data.subject !== undefined) {
    current.subject = data.subject
  }

  if (data.body === null) {
    delete current.body
  } else if (data.body !== undefined) {
    current.body = data.body
  }

  if (current.subject === undefined && current.body === undefined) {
    delete edits[commitSha]
  } else {
    edits[commitSha] = current
  }

  file.messageEdits = edits
  file.baseBranch = baseBranch
  file.branch = branch
  return writeCommentsFile(repoPath, file)
}

export async function setReviewed(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commitSha: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = setReviewedSchema.parse(input)
  const file = await readComments(repoPath, branch, baseBranch)
  const set = new Set(file.reviewedShas ?? [])
  if (data.reviewed) {
    set.add(commitSha)
  } else {
    set.delete(commitSha)
  }
  file.reviewedShas = [...set]
  file.baseBranch = baseBranch
  file.branch = branch
  return writeCommentsFile(repoPath, file)
}

export type ActiveReview = {
  config: ReviewConfig
  file: CommentsFile
}

/** Config plus the comments file for the branch currently under review. */
export async function readActiveReview(repoPath: string): Promise<ActiveReview> {
  const config = await readConfig(repoPath)
  if (!isConfigReady(config)) {
    throw Object.assign(
      new Error(
        'No review configured for this repo. Choose a review branch and a base branch in branch-review first.',
      ),
      { status: 400 },
    )
  }
  const file = await readComments(repoPath, config.reviewBranch, config.baseBranch)
  return { config, file }
}
