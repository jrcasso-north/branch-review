import { z } from 'zod'

export const lineTypeSchema = z.enum(['added', 'removed', 'unchanged'])

const commentResolvedFields = {
  /** When true, comment stays on disk but is treated as done. Omit or false = open. */
  resolved: z.boolean().optional(),
  resolvedAt: z.string().datetime().optional(),
}

const commentDispatchFields = {
  /** When true, the reviewer handed this comment to an agent. Omit or false = not sent. */
  dispatched: z.boolean().optional(),
  dispatchedAt: z.string().datetime().optional(),
}

export const lineCommentSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('line'),
    commitSha: z.string().min(1),
    diffBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    path: z.string().min(1),
    /** Last line of the range (inclusive); comment thread anchors here. */
    line: z.number().int().positive(),
    /** First line of a multi-line range; omit for a single-line comment. */
    startLine: z.number().int().positive().optional(),
    lineType: lineTypeSchema,
    snippet: z.string().optional(),
    body: z.string().min(1),
    createdAt: z.string().datetime(),
    ...commentResolvedFields,
    ...commentDispatchFields,
  })
  .refine((value) => value.startLine === undefined || value.startLine <= value.line, {
    message: 'startLine must be <= line',
    path: ['startLine'],
  })

export const fileCommentSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('file'),
  commitSha: z.string().min(1),
  diffBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  path: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.string().datetime(),
  ...commentResolvedFields,
  ...commentDispatchFields,
})

export const commitCommentSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('commit'),
  commitSha: z.string().min(1),
  diffBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  body: z.string().min(1),
  createdAt: z.string().datetime(),
  ...commentResolvedFields,
  ...commentDispatchFields,
})

export const commentSchema = z.discriminatedUnion('kind', [
  lineCommentSchema,
  fileCommentSchema,
  commitCommentSchema,
]).refine(hasValidSnapshotHead, { message: 'Branch comments require a full commit SHA' })

export const messageEditSchema = z
  .object({
    subject: z.string().min(1).optional(),
    body: z.string().optional(),
  })
  .refine((value) => value.subject !== undefined || value.body !== undefined, {
    message: 'message edit must include subject and/or body',
  })

export const commentsFileSchema = z.object({
  version: z.literal(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  updatedAt: z.string().datetime(),
  comments: z.array(commentSchema),
  messageEdits: z.record(z.string(), messageEditSchema).default({}),
  reviewedShas: z.array(z.string().min(1)).default([]),
})

export const setReviewedSchema = z.object({
  reviewed: z.boolean(),
})

export const configSchema = z.object({
  baseBranch: z.string().min(1),
  reviewBranch: z.string().min(1),
})

/** Accepts older configs that only stored baseBranch. */
export const storedConfigSchema = z.object({
  baseBranch: z.string().min(1),
  reviewBranch: z.string().min(1).optional(),
})

export const createLineCommentSchema = z
  .object({
    kind: z.literal('line'),
    commitSha: z.string().min(1),
    diffBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    path: z.string().min(1),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    lineType: lineTypeSchema,
    snippet: z.string().optional(),
    body: z.string().min(1),
  })
  .refine((value) => value.startLine === undefined || value.startLine <= value.line, {
    message: 'startLine must be <= line',
    path: ['startLine'],
  })

export const createFileCommentSchema = z.object({
  kind: z.literal('file'),
  commitSha: z.string().min(1),
  diffBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  path: z.string().min(1),
  body: z.string().min(1),
})

export const createCommitCommentSchema = z.object({
  kind: z.literal('commit'),
  commitSha: z.string().min(1),
  diffBaseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  body: z.string().min(1),
})

export const createCommentSchema = z.discriminatedUnion('kind', [
  createLineCommentSchema,
  createFileCommentSchema,
  createCommitCommentSchema,
]).refine(hasValidSnapshotHead, { message: 'Branch comments require a full commit SHA' })

export const updateCommentSchema = z
  .object({
    body: z.string().min(1).optional(),
    resolved: z.boolean().optional(),
    dispatched: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.body !== undefined || value.resolved !== undefined || value.dispatched !== undefined,
    {
      message: 'Provide body, resolved and/or dispatched',
    },
  )

export const bulkUpdateCommentsSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
    body: z.string().min(1).optional(),
    resolved: z.boolean().optional(),
    dispatched: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.body !== undefined || value.resolved !== undefined || value.dispatched !== undefined,
    {
      message: 'Provide body, resolved and/or dispatched',
    },
  )

export const upsertMessageEditSchema = z
  .object({
    subject: z.union([z.string().min(1), z.null()]).optional(),
    body: z.union([z.string(), z.null()]).optional(),
  })
  .refine((value) => value.subject !== undefined || value.body !== undefined, {
    message: 'Provide subject and/or body (null clears that field)',
  })

export type Comment = z.infer<typeof commentSchema>
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>
export type MessageEdit = z.infer<typeof messageEditSchema>
export type CommentsFile = z.infer<typeof commentsFileSchema>
export type ReviewConfig = z.infer<typeof configSchema>
export type LineType = z.infer<typeof lineTypeSchema>

function hasValidSnapshotHead(comment: { commitSha: string; diffBaseSha?: string }): boolean {
  return comment.diffBaseSha === undefined || /^[0-9a-f]{40}$/.test(comment.commitSha)
}
