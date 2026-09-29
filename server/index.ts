import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import {
  branchExists,
  detectDefaultBranch,
  getCheckedOutBranch,
  getCommitDiff,
  getBranchDiff,
  getRangeDiffStat,
  GitError,
  inferStackBaseBranch,
  listBranches,
  listCommitsNotInBase,
} from './git.js'
import {
  addComment,
  deleteComment,
  isConfigReady,
  readComments,
  readConfig,
  setReviewed,
  updateComment,
  updateComments,
  upsertMessageEdit,
  writeConfig,
} from './review-store.js'
import {
  assertAllowedRepo,
  assertScanRoot,
  listRepos,
  parseScanRoot,
} from './repos.js'
import { pickDirectory } from './pick-directory.js'
import { bulkUpdateCommentsSchema, configSchema } from './schema.js'
import {
  enqueueSchema,
  queueItemRefSchema,
  setQueueStatusSchema,
} from './queue-schema.js'
import { readQueue } from './queue-store.js'
import {
  activateQueueItem,
  advanceQueue,
  clearFinished,
  enqueuePullRequests,
  removeQueueItem,
  setQueueItemStatus,
} from './queue-service.js'

const initialScan = parseScanRoot()
let roots = [initialScan.root]
let fromCli = initialScan.fromCli
const port = Number(process.env.PORT ?? 8787)

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

function asyncHandler(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next)
  }
}

async function resolveRepo(req: express.Request): Promise<string> {
  const raw = req.header('x-repo-path') ?? req.query.repo
  if (raw == null || String(raw).trim() === '') {
    throw Object.assign(new Error('X-Repo-Path header or repo query is required'), {
      status: 400,
    })
  }
  try {
    return await assertAllowedRepo(String(raw), roots)
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      status: 400,
    })
  }
}

app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      roots,
      fromCli,
    })
  }),
)

async function respondWithRepos(
  res: express.Response,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const repos = await listRepos(roots)
  res.json({ roots, fromCli, repos, ...extra })
}

app.get(
  '/api/repos',
  asyncHandler(async (_req, res) => {
    await respondWithRepos(res)
  }),
)

app.put(
  '/api/repo-roots',
  asyncHandler(async (req, res) => {
    const raw = req.body?.roots
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((r) => typeof r !== 'string')) {
      throw Object.assign(new Error('body.roots must be a non-empty string array'), {
        status: 400,
      })
    }
    roots = await Promise.all(raw.map((r) => assertScanRoot(String(r))))
    fromCli = false
    await respondWithRepos(res)
  }),
)

app.post(
  '/api/repo-roots/pick',
  asyncHandler(async (_req, res) => {
    const chosen = await pickDirectory('Choose a folder to scan for git repositories')
    if (!chosen) {
      await respondWithRepos(res, { cancelled: true })
      return
    }
    roots = [await assertScanRoot(chosen)]
    fromCli = false
    await respondWithRepos(res, { cancelled: false })
  }),
)

app.get(
  '/api/queue',
  asyncHandler(async (_req, res) => {
    res.json(await readQueue())
  }),
)

app.post(
  '/api/queue',
  asyncHandler(async (req, res) => {
    const { text, addedBy } = enqueueSchema.parse(req.body)
    res.status(201).json(await enqueuePullRequests(text, roots, addedBy))
  }),
)

app.post(
  '/api/queue/activate',
  asyncHandler(async (req, res) => {
    const { id } = queueItemRefSchema.parse(req.body)
    res.json(await activateQueueItem(id))
  }),
)

app.post(
  '/api/queue/next',
  asyncHandler(async (_req, res) => {
    res.json(await advanceQueue())
  }),
)

app.post(
  '/api/queue/status',
  asyncHandler(async (req, res) => {
    const { id, status } = setQueueStatusSchema.parse(req.body)
    res.json({ queue: await setQueueItemStatus(id, status) })
  }),
)

app.post(
  '/api/queue/remove',
  asyncHandler(async (req, res) => {
    const { id } = queueItemRefSchema.parse(req.body)
    res.json({ queue: await removeQueueItem(id) })
  }),
)

app.post(
  '/api/queue/clear-finished',
  asyncHandler(async (_req, res) => {
    res.json({ queue: await clearFinished() })
  }),
)

app.get(
  '/api/meta',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const checkedOutBranch = await getCheckedOutBranch(repoPath)
    const config = await readConfig(repoPath)
    const branches = await listBranches(repoPath)
    const defaultBaseBranch = await detectDefaultBranch(repoPath)
    const defaultReviewBranch = checkedOutBranch
    const suggestFor = config?.reviewBranch ?? defaultReviewBranch
    const suggestedBase = suggestFor
      ? await inferStackBaseBranch(repoPath, suggestFor)
      : null
    res.json({
      repoPath,
      checkedOutBranch,
      config,
      branches,
      defaultBaseBranch,
      defaultReviewBranch,
      suggestedBase,
    })
  }),
)

app.get(
  '/api/suggest-base',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const reviewBranch = String(req.query.reviewBranch ?? '').trim()
    if (!reviewBranch) {
      res.status(400).json({ error: 'reviewBranch query param is required' })
      return
    }
    if (!(await branchExists(repoPath, reviewBranch))) {
      res.status(400).json({ error: `Review branch not found: ${reviewBranch}` })
      return
    }
    const suggestedBase = await inferStackBaseBranch(repoPath, reviewBranch)
    res.json({ reviewBranch, suggestedBase })
  }),
)

app.get(
  '/api/config',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    res.json({ config })
  }),
)

app.put(
  '/api/config',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const parsed = configSchema.parse(req.body)
    if (!(await branchExists(repoPath, parsed.baseBranch))) {
      res.status(400).json({ error: `Base branch not found: ${parsed.baseBranch}` })
      return
    }
    if (!(await branchExists(repoPath, parsed.reviewBranch))) {
      res.status(400).json({ error: `Review branch not found: ${parsed.reviewBranch}` })
      return
    }
    if (parsed.baseBranch === parsed.reviewBranch) {
      res.status(400).json({ error: 'Review branch and base branch must differ' })
      return
    }
    const config = await writeConfig(repoPath, parsed)
    res.json({ config })
  }),
)

app.get(
  '/api/commits',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const [commits, stats] = await Promise.all([
      listCommitsNotInBase(repoPath, config.baseBranch, config.reviewBranch),
      getRangeDiffStat(repoPath, config.baseBranch, config.reviewBranch),
    ])
    res.json({
      baseBranch: config.baseBranch,
      reviewBranch: config.reviewBranch,
      commits,
      stats,
    })
  }),
)

app.get(
  '/api/branch-diff',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    res.json(await getBranchDiff(repoPath, config.baseBranch, config.reviewBranch))
  }),
)

app.get(
  '/api/commits/:sha/diff',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const sha = String(req.params.sha)
    const files = await getCommitDiff(repoPath, sha)
    res.json({ sha, files })
  }),
)

app.get(
  '/api/comments',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const file = await readComments(repoPath, config.reviewBranch, config.baseBranch)
    res.json(file)
  }),
)

app.post(
  '/api/comments',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const file = await addComment(repoPath, config.reviewBranch, config.baseBranch, req.body)
    res.status(201).json(file)
  }),
)

app.patch(
  '/api/comments',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const { ids, ...patch } = bulkUpdateCommentsSchema.parse(req.body)
    const file = await updateComments(
      repoPath,
      config.reviewBranch,
      config.baseBranch,
      ids,
      patch,
    )
    res.json(file)
  }),
)

app.patch(
  '/api/comments/:id',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const file = await updateComment(
      repoPath,
      config.reviewBranch,
      config.baseBranch,
      String(req.params.id),
      req.body,
    )
    res.json(file)
  }),
)

app.delete(
  '/api/comments/:id',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const file = await deleteComment(
      repoPath,
      config.reviewBranch,
      config.baseBranch,
      String(req.params.id),
    )
    res.json(file)
  }),
)

app.put(
  '/api/message-edits/:sha',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const file = await upsertMessageEdit(
      repoPath,
      config.reviewBranch,
      config.baseBranch,
      String(req.params.sha),
      req.body,
    )
    res.json(file)
  }),
)

app.put(
  '/api/reviewed/:sha',
  asyncHandler(async (req, res) => {
    const repoPath = await resolveRepo(req)
    const config = await readConfig(repoPath)
    if (!isConfigReady(config)) {
      res.status(400).json({ error: 'Set reviewBranch and baseBranch in config first' })
      return
    }
    const file = await setReviewed(
      repoPath,
      config.reviewBranch,
      config.baseBranch,
      String(req.params.sha),
      req.body,
    )
    res.json(file)
  }),
)

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof GitError) {
      res.status(400).json({ error: err.message, detail: err.stderr })
      return
    }
    if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
      res.status(err.status).json({
        error: err instanceof Error ? err.message : 'Request error',
      })
      return
    }
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ZodError') {
      res.status(400).json({ error: 'Invalid request', detail: err })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  },
)

async function main() {
  try {
    roots = [await assertScanRoot(initialScan.root)]
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const isProd = process.env.NODE_ENV === 'production'
  if (isProd) {
    const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
    app.use(express.static(dist))
    // Express 5's sendFile rejects absolute paths; pass a root-relative name.
    app.get(/.*/, (_req, res) => {
      res.sendFile('index.html', { root: dist })
    })
  }

  app.listen(port, () => {
    console.log(`branch-review listening on http://localhost:${port}`)
    console.log(`scan root: ${roots.join(', ')}${fromCli ? ' (from CLI)' : ''}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
