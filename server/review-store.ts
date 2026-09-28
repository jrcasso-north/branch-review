import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { ulid } from 'ulid'
import { withFileLock } from './file-lock.js'
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
  type UpdateCommentInput,
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

function commentsLockPath(repoPath: string, branch: string): string {
  return `${commentsPath(repoPath, branch)}.lock`
}

/** Rename is atomic, so a reader never observes a half-written file. */
async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, target)
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
  await writeJsonAtomic(configPath(repoPath), parsed)
  return parsed
}

type SchemaIssue = { path: (string | number)[]; message: string }

/** Point at the offending field; a zod error stringifies to unreadable json. */
function describeReadFailure(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'issues' in error) {
    const [issue] = (error as { issues: SchemaIssue[] }).issues
    if (issue !== undefined) {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'the file'
      return `${where} is not valid (${issue.message})`
    }
  }
  return error instanceof Error ? (error.message.split('\n')[0] ?? 'unreadable') : String(error)
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
  const target = commentsPath(repoPath, branch)

  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyCommentsFile(branch, baseBranch)
    }
    throw error
  }

  try {
    return commentsFileSchema.parse(migrateLegacyLineRange(JSON.parse(raw)))
  } catch (error) {
    const detail = describeReadFailure(error)
    throw Object.assign(
      new Error(
        `Could not read ${target}: ${detail}. Fix or move that file. ` +
          'Treating it as empty would discard the comments it holds.',
      ),
      { status: 500 },
    )
  }
}

async function writeCommentsFile(repoPath: string, file: CommentsFile): Promise<CommentsFile> {
  await ensureReviewDir(repoPath)
  const parsed = commentsFileSchema.parse({
    ...file,
    updatedAt: new Date().toISOString(),
  })
  await writeJsonAtomic(commentsPath(repoPath, parsed.branch), parsed)
  return parsed
}

/**
 * Run a read-modify-write on the comments file while holding its lock, so a
 * concurrent writer in another process cannot drop the change.
 */
async function mutateComments(
  repoPath: string,
  branch: string,
  baseBranch: string,
  mutate: (file: CommentsFile) => void,
): Promise<CommentsFile> {
  await ensureReviewDir(repoPath)
  return withFileLock(commentsLockPath(repoPath, branch), async () => {
    const file = await readComments(repoPath, branch, baseBranch)
    mutate(file)
    file.branch = branch
    file.baseBranch = baseBranch
    return writeCommentsFile(repoPath, file)
  })
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

  return mutateComments(repoPath, branch, baseBranch, (file) => {
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

    file.comments.push(comment)
  })
}

function applyCommentUpdate(comment: Comment, data: UpdateCommentInput): Comment {
  const next: Comment = { ...comment }
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
  return next
}

export async function updateComment(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commentId: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = updateCommentSchema.parse(input)

  return mutateComments(repoPath, branch, baseBranch, (file) => {
    const index = file.comments.findIndex((c) => c.id === commentId)
    if (index === -1) {
      throw Object.assign(new Error(`Comment not found: ${commentId}`), { status: 404 })
    }
    file.comments[index] = applyCommentUpdate(file.comments[index]!, data)
  })
}

/**
 * Apply one patch to every listed comment in a single write. Sending a review
 * to an agent touches many comments at once, and one write keeps the file
 * consistent for anyone reading it.
 */
export async function updateComments(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commentIds: string[],
  input: unknown,
): Promise<CommentsFile> {
  const data = updateCommentSchema.parse(input)
  const wanted = new Set(commentIds)

  return mutateComments(repoPath, branch, baseBranch, (file) => {
    const found = new Set<string>()
    file.comments = file.comments.map((comment) => {
      if (!wanted.has(comment.id)) return comment
      found.add(comment.id)
      return applyCommentUpdate(comment, data)
    })
    const missing = [...wanted].filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw Object.assign(new Error(`Comments not found: ${missing.join(', ')}`), {
        status: 404,
      })
    }
  })
}

export async function deleteComment(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commentId: string,
): Promise<CommentsFile> {
  return mutateComments(repoPath, branch, baseBranch, (file) => {
    file.comments = file.comments.filter((c) => c.id !== commentId)
  })
}

export async function upsertMessageEdit(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commitSha: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = upsertMessageEditSchema.parse(input)

  return mutateComments(repoPath, branch, baseBranch, (file) => {
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
  })
}

export async function setReviewed(
  repoPath: string,
  branch: string,
  baseBranch: string,
  commitSha: string,
  input: unknown,
): Promise<CommentsFile> {
  const data = setReviewedSchema.parse(input)

  return mutateComments(repoPath, branch, baseBranch, (file) => {
    const set = new Set(file.reviewedShas ?? [])
    if (data.reviewed) {
      set.add(commitSha)
    } else {
      set.delete(commitSha)
    }
    file.reviewedShas = [...set]
  })
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
