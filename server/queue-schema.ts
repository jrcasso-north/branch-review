import { z } from 'zod'

export const queueStatusSchema = z.enum(['queued', 'active', 'done'])

export const queueItemSchema = z.object({
  /** owner/repo#number. Stable, so the same PR is never queued twice. */
  id: z.string().min(1),
  url: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  status: queueStatusSchema,
  addedAt: z.string().datetime(),
  /** Who put it in the queue, so a paste and an agent are told apart. */
  addedBy: z.enum(['ui', 'agent']),
  title: z.string().optional(),
  author: z.string().optional(),
  /** Local clone the PR was matched to. Absent until it resolves. */
  repoPath: z.string().optional(),
  reviewBranch: z.string().optional(),
  baseBranch: z.string().optional(),
  /** Why this one cannot be opened, e.g. no local clone for the repo. */
  error: z.string().optional(),
  resolvedAt: z.string().datetime().optional(),
})

export const queueFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  items: z.array(queueItemSchema),
  activeId: z.union([z.string().min(1), z.null()]).default(null),
})

export const enqueueSchema = z.object({
  text: z.string().min(1),
  addedBy: z.enum(['ui', 'agent']).default('ui'),
})

export const updateQueueItemSchema = z
  .object({
    status: queueStatusSchema.optional(),
  })
  .refine((value) => value.status !== undefined, {
    message: 'Provide status',
  })

export const queueItemRefSchema = z.object({
  id: z.string().min(1),
})

export const setQueueStatusSchema = z.object({
  id: z.string().min(1),
  status: queueStatusSchema,
})

export type QueueStatus = z.infer<typeof queueStatusSchema>
export type QueueItem = z.infer<typeof queueItemSchema>
export type QueueFile = z.infer<typeof queueFileSchema>
