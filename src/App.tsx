import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  fetchComments,
  fetchCommits,
  fetchDiff,
  fetchBranchDiff,
  fetchMeta,
  fetchRepos,
  fetchSuggestedBase,
  getActiveRepoPath,
  pickRepoRoot,
  readStoredRepoPath,
  saveConfig,
  setActiveRepoPath,
  setCommentsDispatched,
  fetchQueue,
  enqueuePullRequests,
  activateQueueItem,
  advanceQueue,
  removeQueueItem,
  clearFinishedQueueItems,
  setQueueItemBase,
} from './api'
import { QueuePanel } from './QueuePanel'
import { sendableToAgent } from './comments'
import { CommitReview } from './CommitReview'
import { DiffStat } from './DiffStat'
import {
  AgentIcon,
  CheckboxIcon,
  CommentBubbleIcon,
  CommitIcon,
  CheckIcon,
  MergeIcon,
  MoonIcon,
  SunIcon,
} from './icons'
import { effectiveTheme, toggleStoredTheme, type ThemePreference } from './theme'
import type {
  BranchDiff,
  Comment,
  CommitSummary,
  DiffFile,
  DiffStatCounts,
  MessageEdit,
  MetaResponse,
  QueueFile,
  QueueItem,
  RepoInfo,
} from './types'
import { parseViewUrl, replaceViewUrl } from './viewUrl'
import './App.css'

const REVIEW_BRANCH_PLACEHOLDER = ''
const CHANGE_DIRECTORY_VALUE = '__change_directory__'

function configIsReady(
  config: MetaResponse['config'],
): config is MetaResponse['config'] & { baseBranch: string; reviewBranch: string } {
  return Boolean(config?.baseBranch && config.reviewBranch)
}

/** True when the view URL's repo segment refers to `repoPath`. */
function viewUrlMatchesRepo(
  url: { repoName: string | null },
  repoPath: string,
): boolean {
  if (!url.repoName) return false
  if (url.repoName === repoPath) return true
  const base = repoPath.replace(/\/+$/, '').split('/').pop()
  return Boolean(base && url.repoName === base)
}

function metaHasBranch(meta: MetaResponse, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const { local, remote } = meta.branches
  if (local.includes(trimmed) || remote.includes(trimmed)) return true
  return remote.some((r) => r === `origin/${trimmed}` || r.endsWith(`/${trimmed}`))
}

function withBranch(branches: string[], extra: string | null | undefined): string[] {
  if (!extra) return branches
  if (branches.includes(extra)) return branches
  return [extra, ...branches]
}

function partitionBranchOptions(
  lists: { local: string[]; remote: string[] } | undefined,
  extra: string | null | undefined,
): { local: string[]; remote: string[] } {
  const local = [...(lists?.local ?? [])]
  const remote = (lists?.remote ?? []).filter((b) => !local.includes(b))
  if (!extra) return { local, remote }
  if (local.includes(extra) || remote.includes(extra)) return { local, remote }
  return { local: withBranch(local, extra), remote }
}

function BranchOptionGroups({
  local,
  remote,
}: {
  local: string[]
  remote: string[]
}) {
  return (
    <>
      {local.length > 0 ? (
        <optgroup label="Local">
          {local.map((b) => (
            <option key={`local:${b}`} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
      ) : null}
      {remote.length > 0 ? (
        <optgroup label="Remote">
          {remote.map((b) => (
            <option key={`remote:${b}`} value={b}>
              {b}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  )
}

function repoFromQuery(): string | null {
  const value = new URLSearchParams(window.location.search).get('repo')
  return value && value.trim() ? value.trim() : null
}

function pickInitialRepo(repos: RepoInfo[]): string | null {
  const url = parseViewUrl()
  if (url.repoName) {
    const byName = repos.find((r) => r.name === url.repoName)
    if (byName) return byName.path
    const byPath = repos.find((r) => r.path === url.repoName)
    if (byPath) return byPath.path
  }
  const candidates = [repoFromQuery(), readStoredRepoPath()]
  for (const candidate of candidates) {
    if (candidate && repos.some((r) => r.path === candidate)) return candidate
  }
  return repos[0]?.path ?? null
}

function matchCommitSha(
  commits: CommitSummary[],
  want: string | null | undefined,
): string | null {
  if (!want) return null
  const exact = commits.find((c) => c.sha === want)
  if (exact) return exact.sha
  const prefix = commits.find(
    (c) => c.sha.startsWith(want) || want.startsWith(c.sha) || c.shortSha === want,
  )
  return prefix?.sha ?? null
}

const COMMITS_COLLAPSED_KEY = 'branch-review.commitsCollapsed'

function readStoredCommitsCollapsed(): boolean {
  try {
    return localStorage.getItem(COMMITS_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeStoredCommitsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COMMITS_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([])
  const [repoPath, setRepoPath] = useState<string | null>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [baseDraft, setBaseDraft] = useState('main')
  const [reviewDraft, setReviewDraft] = useState('')
  const [commits, setCommits] = useState<CommitSummary[]>([])
  const [branchStats, setBranchStats] = useState<DiffStatCounts | null>(null)
  const [branchView, setBranchView] = useState(() => !parseViewUrl().commitSha)
  const [branchDiff, setBranchDiff] = useState<BranchDiff | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [files, setFiles] = useState<DiffFile[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [messageEdits, setMessageEdits] = useState<Record<string, MessageEdit>>({})
  const [reviewedShas, setReviewedShas] = useState<string[]>([])
  const [reviewedPaths, setReviewedPaths] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [diffLoading, setDiffLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [commitsCollapsed, setCommitsCollapsedState] = useState(readStoredCommitsCollapsed)
  const [theme, setTheme] = useState<ThemePreference>(() => effectiveTheme())
  const [activeFilePath, setActiveFilePath] = useState<string | null>(
    () => parseViewUrl().filePath,
  )
  const [seedFilePath, setSeedFilePath] = useState<string | null>(
    () => parseViewUrl().filePath,
  )
  const [commitsScrolled, setCommitsScrolled] = useState(false)
  const [showReviewed, setShowReviewed] = useState(true)
  const [showMerges, setShowMerges] = useState(true)
  const [sendingAll, setSendingAll] = useState(false)
  const [queue, setQueue] = useState<QueueFile | null>(null)
  const [queueBusy, setQueueBusy] = useState(false)
  const hydrated = useRef(false)
  const configSaveGen = useRef(0)
  const preferShaRef = useRef<string | null>(parseViewUrl().commitSha)
  /** When true, do not overwrite baseDraft from suggest-base (saved or user-picked). */
  const baseLockedRef = useRef(false)

  function setCommitsCollapsed(collapsed: boolean) {
    setCommitsCollapsedState(collapsed)
    writeStoredCommitsCollapsed(collapsed)
  }

  const loadReviewData = useCallback(async () => {
    const repo = getActiveRepoPath()
    const generation = configSaveGen.current
    const [commitRes, commentRes, diffRes] = await Promise.all([
      fetchCommits(), fetchComments(), fetchBranchDiff(),
    ])
    if (repo !== getActiveRepoPath() || generation !== configSaveGen.current) return
    setBranchDiff(diffRes)
    setCommits(commitRes.commits)
    setBranchStats(commitRes.stats)
    setComments(commentRes.comments)
    setMessageEdits(commentRes.messageEdits ?? {})
    setReviewedShas(commentRes.reviewedShas ?? [])
    setReviewedPaths(commentRes.reviewedPaths ?? {})
    setSelectedSha((prev) => {
      const fromUrl = matchCommitSha(commitRes.commits, preferShaRef.current)
      if (fromUrl) {
        preferShaRef.current = null
        return fromUrl
      }
      if (prev && commitRes.commits.some((c) => c.sha === prev)) return prev
      return commitRes.commits[0]?.sha ?? null
    })
  }, [])

  const loadRepo = useCallback(
    async (nextRepo: string, prefer?: { reviewBranch: string; baseBranch: string }) => {
      setActiveRepoPath(nextRepo)
      setRepoPath(nextRepo)
      hydrated.current = false
      // Cancel in-flight config saves and drop the previous repo's branches so
      // we never PUT a compare branch that does not exist in the new repo.
      configSaveGen.current += 1
      baseLockedRef.current = false
      setError(null)
      setCommits([])
      setBranchStats(null)
      setBranchDiff(null)
      setFiles([])
      setComments([])
      setMessageEdits({})
      setSelectedSha(null)
      setReviewDraft(REVIEW_BRANCH_PLACEHOLDER)
      setBaseDraft('')

      const m = await fetchMeta()
      setMeta(m)
      const url = parseViewUrl()
      const urlForThisRepo = viewUrlMatchesRepo(url, nextRepo)
      setBranchView(!urlForThisRepo || !url.commitSha)
      const urlBranchesOk =
        urlForThisRepo &&
        Boolean(url.reviewBranch && url.baseBranch) &&
        metaHasBranch(m, url.reviewBranch!) &&
        metaHasBranch(m, url.baseBranch!)

      if (prefer) {
        // A queued pull request is authoritative. The URL still describes the
        // previous one, and for two pull requests in the same repository it
        // matches on the repo name and would otherwise win.
        setReviewDraft(prefer.reviewBranch)
        setBaseDraft(prefer.baseBranch)
        baseLockedRef.current = true
        preferShaRef.current = null
        setSeedFilePath(null)
        setActiveFilePath(null)
        await loadReviewData()
      } else if (urlBranchesOk && url.reviewBranch && url.baseBranch) {
        setReviewDraft(url.reviewBranch)
        setBaseDraft(url.baseBranch)
        baseLockedRef.current = true
        preferShaRef.current = url.commitSha
        setSeedFilePath(url.filePath)
        setActiveFilePath(url.filePath)
        if (
          m.config?.reviewBranch === url.reviewBranch &&
          m.config?.baseBranch === url.baseBranch
        ) {
          await loadReviewData()
        }
      } else if (configIsReady(m.config) && metaHasBranch(m, m.config.reviewBranch)) {
        setReviewDraft(m.config.reviewBranch)
        if (metaHasBranch(m, m.config.baseBranch)) {
          setBaseDraft(m.config.baseBranch)
          baseLockedRef.current = true
          await loadReviewData()
        } else {
          // Saved review branch is fine; re-pick compare for this repo.
          setBaseDraft(m.suggestedBase?.baseBranch ?? m.defaultBaseBranch)
          baseLockedRef.current = false
        }
      } else {
        setReviewDraft(REVIEW_BRANCH_PLACEHOLDER)
        setBaseDraft(m.suggestedBase?.baseBranch ?? m.defaultBaseBranch)
        baseLockedRef.current = false
      }
      hydrated.current = true
    },
    [loadReviewData],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const listed = await fetchRepos()
        if (cancelled) return
        setRepos(listed.repos)
        const initial = pickInitialRepo(listed.repos)
        if (!initial) {
          setActiveRepoPath(null)
          setRepoPath(null)
          setMeta(null)
          return
        }
        await loadRepo(initial)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadRepo])

  useEffect(() => {
    if (!hydrated.current || !reviewDraft.trim() || !getActiveRepoPath()) return
    let cancelled = false
    const handle = window.setTimeout(() => {
      const review = reviewDraft.trim()
      fetchSuggestedBase(review)
        .then((res) => {
          if (cancelled) return
          // Keep a saved or manually chosen base; unlock happens when review changes.
          if (baseLockedRef.current) return
          if (res.suggestedBase) {
            setBaseDraft(res.suggestedBase.baseBranch)
          }
        })
        .catch(() => {
          /* keep prior base */
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [reviewDraft, repoPath])

  useEffect(() => {
    if (!hydrated.current || !meta || !getActiveRepoPath()) return
    const reviewBranch = reviewDraft.trim()
    const baseBranch = baseDraft.trim()
    if (!reviewBranch || !baseBranch || reviewBranch === baseBranch) {
      setSavingConfig(false)
      return
    }
    if (meta.config?.reviewBranch === reviewBranch && meta.config?.baseBranch === baseBranch) {
      setSavingConfig(false)
      return
    }

    const gen = ++configSaveGen.current
    let cancelled = false
    const handle = window.setTimeout(() => {
      setSavingConfig(true)
      setError(null)
      saveConfig({ baseBranch, reviewBranch })
        .then(async ({ config }) => {
          if (cancelled || configSaveGen.current !== gen) return
          setMeta((m) => (m ? { ...m, config } : m))
          await loadReviewData()
        })
        .catch((e) => {
          if (!cancelled && configSaveGen.current === gen) {
            setError(e instanceof Error ? e.message : 'Failed to save config')
          }
        })
        .finally(() => {
          if (configSaveGen.current === gen) setSavingConfig(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [reviewDraft, baseDraft, meta, loadReviewData, repoPath])

  useEffect(() => {
    const repo = repos.find((r) => r.path === repoPath)?.name
    const branch = reviewDraft.trim()
    if (repo && branch) {
      document.title = `Branch Review: ${repo}/${branch}`
    } else if (repo) {
      document.title = `Branch Review: ${repo}`
    } else {
      document.title = 'Branch Review'
    }
  }, [repos, repoPath, reviewDraft])

  useEffect(() => {
    setCommitsScrolled(false)
  }, [commits, repoPath, commitsCollapsed])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => setTheme(effectiveTheme())
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    const onPopState = () => {
      const url = parseViewUrl()
      preferShaRef.current = url.commitSha
      setBranchView(!url.commitSha)
      setSeedFilePath(url.filePath)
      setActiveFilePath(url.filePath)

      if (url.repoName && repos.length > 0) {
        const match =
          repos.find((r) => r.name === url.repoName) ??
          repos.find((r) => r.path === url.repoName)
        if (match && match.path !== repoPath) {
          void loadRepo(match.path).catch((e) => {
            setError(e instanceof Error ? e.message : 'Failed to switch repo')
          })
          return
        }
      }
      if (url.reviewBranch) setReviewDraft(url.reviewBranch)
      if (url.baseBranch) setBaseDraft(url.baseBranch)
      if (url.commitSha && commits.length > 0) {
        const sha = matchCommitSha(commits, url.commitSha)
        if (sha) setSelectedSha(sha)
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [repos, repoPath, commits, loadRepo])

  useEffect(() => {
    if (!hydrated.current || !repoPath) return
    const repo = repos.find((r) => r.path === repoPath)
    if (!repo) return
    const review = reviewDraft.trim()
    const base = baseDraft.trim()
    replaceViewUrl({
      repoName: repo.name,
      reviewBranch: review || null,
      baseBranch: base || null,
      commitSha: branchView ? null : selectedSha,
      filePath: activeFilePath,
    })
  }, [
    repoPath,
    repos,
    reviewDraft,
    baseDraft,
    selectedSha,
    branchView,
    activeFilePath,
  ])

  const needsReviewPick = Boolean(meta && !configIsReady(meta.config))
  const showSetupHint = needsReviewPick && !commitsCollapsed

  useEffect(() => {
    if (branchView || !selectedSha) {
      setDiffLoading(false)
      setFiles([])
      return
    }
    let cancelled = false
    setDiffLoading(true)
    fetchDiff(selectedSha)
      .then((res) => {
        if (!cancelled) setFiles(res.files)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load diff')
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSha, repoPath, branchView])

  const reviewOptions = useMemo(
    () =>
      partitionBranchOptions(
        meta?.branches,
        reviewDraft && reviewDraft !== REVIEW_BRANCH_PLACEHOLDER ? reviewDraft : null,
      ),
    [meta?.branches, reviewDraft],
  )

  const baseOptions = useMemo(
    () => partitionBranchOptions(meta?.branches, baseDraft),
    [meta?.branches, baseDraft],
  )

  const reviewedSet = useMemo(() => new Set(reviewedShas), [reviewedShas])
  const sendableAll = useMemo(() => sendableToAgent(comments), [comments])

  async function sendAllToAgent() {
    if (sendableAll.length === 0) return
    setSendingAll(true)
    setError(null)
    try {
      const file = await setCommentsDispatched(
        sendableAll.map((c) => c.id),
        true,
      )
      setComments(file.comments)
      setMessageEdits(file.messageEdits ?? {})
      setReviewedShas(file.reviewedShas ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send comments to the agent')
    } finally {
      setSendingAll(false)
    }
  }

  const commentCountBySha = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of comments) {
      if (comment.diffBaseSha) continue
      counts.set(comment.commitSha, (counts.get(comment.commitSha) ?? 0) + 1)
    }
    return counts
  }, [comments])

  const visibleCommits = useMemo(
    () =>
      commits.filter((c) => {
        if (!showReviewed && reviewedSet.has(c.sha)) return false
        if (!showMerges && c.isMerge) return false
        return true
      }),
    [commits, reviewedSet, showMerges, showReviewed],
  )

  useLayoutEffect(() => {
    if (!selectedSha) return
    if (visibleCommits.some((c) => c.sha === selectedSha)) return
    const oldIndex = commits.findIndex((c) => c.sha === selectedSha)
    const next =
      visibleCommits.find((c) => commits.findIndex((x) => x.sha === c.sha) >= oldIndex) ??
      visibleCommits[visibleCommits.length - 1] ??
      null
    setSelectedSha(next?.sha ?? null)
  }, [visibleCommits, selectedSha, commits])

  const refreshQueue = useCallback(async () => {
    try {
      setQueue(await fetchQueue())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the review queue')
    }
  }, [])

  // The stream sends the current queue on connect, so this covers the first
  // load as well as every later change, including ones an agent makes while
  // the page is open.
  useEffect(() => {
    const source = new EventSource('/api/queue/events')
    source.onmessage = (event) => {
      try {
        setQueue(JSON.parse(event.data) as QueueFile)
      } catch {
        // Ignore a frame that did not survive the wire; the next one replaces it.
      }
    }
    source.onerror = () => {
      // EventSource reconnects by itself. Fetch once so the panel is not left
      // blank if the stream never comes up at all.
      void refreshQueue()
    }
    return () => source.close()
  }, [refreshQueue])

  async function runQueueAction(run: () => Promise<void>) {
    setQueueBusy(true)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Queue action failed')
    } finally {
      setQueueBusy(false)
    }
  }

  async function openQueueTarget(item: QueueItem): Promise<void> {
    if (
      item.repoPath === undefined ||
      item.reviewBranch === undefined ||
      item.baseBranch === undefined
    ) {
      return
    }
    await loadRepo(item.repoPath, {
      reviewBranch: item.reviewBranch,
      baseBranch: item.baseBranch,
    })
  }

  async function onQueueAdd(text: string) {
    await runQueueAction(async () => {
      const result = await enqueuePullRequests(text)
      setQueue(result.queue)
      const problems = [
        ...result.failed.map((f) => `${f.id}: ${f.error}`),
        ...result.skipped.map((line) => `Not a pull request link: ${line}`),
      ]
      if (problems.length > 0) setError(problems.join('  |  '))
    })
  }

  async function onQueueOpen(id: string) {
    await runQueueAction(async () => {
      const result = await activateQueueItem(id)
      setQueue(result.queue)
      await openQueueTarget(result.item)
    })
  }

  async function onQueueNext() {
    await runQueueAction(async () => {
      const result = await advanceQueue()
      setQueue(result.queue)
      if (result.item) await openQueueTarget(result.item)
    })
  }

  async function rememberQueueBase(baseBranch: string): Promise<void> {
    const activeId = queue?.activeId
    if (!activeId) return
    const item = queue?.items.find((entry) => entry.id === activeId)
    if (!item || item.repoPath !== repoPath) return
    try {
      setQueue((await setQueueItemBase(activeId, baseBranch)).queue)
    } catch {
      // Not worth interrupting a review; the choice still applies to this view.
    }
  }

  async function onQueueRemove(id: string) {
    await runQueueAction(async () => {
      setQueue((await removeQueueItem(id)).queue)
    })
  }

  async function onQueueClearFinished() {
    await runQueueAction(async () => {
      setQueue((await clearFinishedQueueItems()).queue)
    })
  }

  async function onRepoChange(next: string) {
    if (next === CHANGE_DIRECTORY_VALUE) {
      await changeScanDirectory()
      return
    }
    setLoading(true)
    try {
      await loadRepo(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch repo')
    } finally {
      setLoading(false)
    }
  }

  async function changeScanDirectory() {
    setLoading(true)
    setError(null)
    configSaveGen.current += 1
    try {
      const listed = await pickRepoRoot()
      if (listed.cancelled) return
      setRepos(listed.repos)
      const next = pickInitialRepo(listed.repos)
      if (!next) {
        setActiveRepoPath(null)
        setRepoPath(null)
        setMeta(null)
        setCommits([])
        setBranchStats(null)
        setFiles([])
        setComments([])
        setMessageEdits({})
        setSelectedSha(null)
        setReviewDraft('')
        setBaseDraft('')
        hydrated.current = false
        return
      }
      await loadRepo(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change directory')
    } finally {
      setLoading(false)
    }
  }

  if (loading && !meta && repos.length === 0) {
    return (
      <div className="app-shell">
        <div className="main-layout">
          <aside className="commit-list">
            <div className="commit-list-header">
              <div className="commit-list-heading">
                <h1 className="commit-list-title">Branch Review</h1>
              </div>
            </div>
          </aside>
          <main className="main-pane">
            <div className="page-loading" role="status" aria-live="polite">
              <span className="page-loading-spinner" aria-hidden="true" />
              <p className="page-loading-text">Loading repositories…</p>
            </div>
          </main>
        </div>
      </div>
    )
  }

  const noRepos = repos.length === 0
  const ready = configIsReady(meta?.config ?? null)
  const selected = visibleCommits.find((c) => c.sha === selectedSha) ?? null
  const selectedIndex = selected ? commits.findIndex((c) => c.sha === selected.sha) : -1
  const visibleIndex = selected
    ? visibleCommits.findIndex((c) => c.sha === selected.sha)
    : -1
  const prevVisible =
    visibleIndex > 0 ? visibleCommits[visibleIndex - 1] : undefined
  const nextVisible =
    visibleIndex >= 0 && visibleIndex < visibleCommits.length - 1
      ? visibleCommits[visibleIndex + 1]
      : undefined

  const branchControls = (
    <div className="branch-controls">
      <div className="field">
        <label htmlFor="repo-path">Repo</label>
        <select
          id="repo-path"
          value={repoPath ?? ''}
          onChange={(e) => {
            void onRepoChange(e.target.value)
          }}
        >
          {noRepos ? (
            <option value="" disabled>
              No repos
            </option>
          ) : null}
          <option value={CHANGE_DIRECTORY_VALUE}>Change directory…</option>
          {repos.map((r) => (
            <option key={r.path} value={r.path} title={r.path}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="review-branch">Review branch</label>
        <select
          id="review-branch"
          value={reviewDraft}
          onChange={(e) => {
            baseLockedRef.current = false
            setReviewDraft(e.target.value)
          }}
          disabled={!meta}
        >
          {reviewDraft === REVIEW_BRANCH_PLACEHOLDER ? (
            <option value={REVIEW_BRANCH_PLACEHOLDER} disabled>
              Select branch
            </option>
          ) : null}
          <BranchOptionGroups local={reviewOptions.local} remote={reviewOptions.remote} />
        </select>
      </div>
      <div className="field">
        <label htmlFor="base-branch">Compare to</label>
        <select
          id="base-branch"
          value={baseDraft}
          onChange={(e) => {
            const next = e.target.value
            baseLockedRef.current = true
            setBaseDraft(next)
            void rememberQueueBase(next)
          }}
          disabled={!meta}
        >
          <BranchOptionGroups local={baseOptions.local} remote={baseOptions.remote} />
        </select>
      </div>
      {savingConfig ? <span className="muted updating-label">Updating…</span> : null}
    </div>
  )

  return (
    <div className="app-shell">
      {error ? <p className="error banner">{error}</p> : null}

      <div className={`main-layout${commitsCollapsed ? ' commits-collapsed' : ''}`}>
        <aside className={`commit-list${commitsCollapsed ? ' is-collapsed' : ''}`}>
          <div className="commit-list-header">
            {commitsCollapsed ? (
              <button
                type="button"
                className="commit-list-toggle"
                aria-expanded={false}
                title="Show commits"
                onClick={() => setCommitsCollapsed(false)}
              >
                <svg
                  className="commit-list-toggle-icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M6.5 3.25 11 8l-4.5 4.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="visually-hidden">Show commits</span>
              </button>
            ) : (
              <>
                <div className="commit-list-heading">
                  <h1 className="commit-list-title">Branch Review</h1>
                  <a
                    className="commit-list-help"
                    href="https://github.com/mpetrovich-north/branch-review"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Project on GitHub"
                  >
                    <svg
                      className="commit-list-help-icon"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                    >
                      <circle
                        cx="8"
                        cy="8"
                        r="6.25"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                      />
                      <circle cx="8" cy="5.35" r="0.7" fill="currentColor" />
                      <path
                        d="M8 7.25v4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span className="visually-hidden">Project on GitHub</span>
                  </a>
                  <button
                    type="button"
                    className="theme-toggle"
                    title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                    aria-label={
                      theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
                    }
                    onClick={() => setTheme(toggleStoredTheme())}
                  >
                    {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
                  </button>
                </div>
                <button
                  type="button"
                  className="commit-list-toggle"
                  aria-expanded={true}
                  aria-controls="commit-list-body"
                  title="Hide commits"
                  onClick={() => setCommitsCollapsed(true)}
                >
                  <svg
                    className="commit-list-toggle-icon"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path
                      d="M9.5 3.25 5 8l4.5 4.75"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="visually-hidden">Hide commits</span>
                </button>
              </>
            )}
          </div>

          {!commitsCollapsed && queue !== null ? (
            <QueuePanel
              queue={queue}
              busy={queueBusy}
              onAdd={onQueueAdd}
              onOpen={onQueueOpen}
              onNext={onQueueNext}
              onRemove={onQueueRemove}
              onClearFinished={onQueueClearFinished}
            />
          ) : null}

          {!commitsCollapsed ? branchControls : null}

          {!commitsCollapsed ? (
            <div id="commit-list-body" className="commit-list-body">
              {noRepos ? null : !meta ? (
                <p className="empty">Loading repository…</p>
              ) : !ready ? null : (
                <>
                  <div className="commit-list-branch">
                    <h2 className="commit-list-branch-name" title={reviewDraft}>
                      {reviewDraft}
                    </h2>
                    <div className="commit-list-branch-meta">
                      <p
                        className="commit-list-branch-vs"
                        title={`vs. ${baseDraft.trim()}`}
                      >
                        vs. {baseDraft.trim()}
                      </p>
                      {branchStats ? <DiffStat {...branchStats} /> : null}
                    </div>
                    <button
                      type="button"
                      className="btn branch-view-button"
                      aria-pressed={branchView}
                      onClick={() => {
                        setBranchView(true)
                        setSeedFilePath(null)
                        window.scrollTo(0, 0)
                      }}
                    >
                      All changes
                    </button>
                    <button
                      type="button"
                      className="btn ghost branch-view-button"
                      disabled={refreshing}
                      onClick={async () => {
                        setRefreshing(true)
                        try {
                          await loadReviewData()
                        } catch (e) {
                          setError(e instanceof Error ? e.message : 'Failed to refresh review')
                        } finally {
                          setRefreshing(false)
                        }
                      }}
                    >
                      {refreshing ? 'Refreshing…' : 'Refresh'}
                    </button>
                    {sendableAll.length > 0 ? (
                      <button
                        type="button"
                        className="reviewed-toggle dispatch-bulk dispatch-bulk-all"
                        title={`Send all ${sendableAll.length} open comment${sendableAll.length === 1 ? '' : 's'} on this branch to the agent`}
                        aria-label={`Send all ${sendableAll.length} open comment${sendableAll.length === 1 ? '' : 's'} on this branch to the agent`}
                        disabled={sendingAll}
                        onClick={() => void sendAllToAgent()}
                      >
                        <AgentIcon />
                        Send all {sendableAll.length}
                      </button>
                    ) : null}
                  </div>
                  {commits.length === 0 ? (
                    <p className="empty">No commits ahead of the base branch.</p>
                  ) : (
                    <>
                      <div
                        className={`commit-list-count${commitsScrolled ? ' is-scrolled' : ''}`}
                      >
                        <span>
                          {commits.length} {commits.length === 1 ? 'commit' : 'commits'}
                        </span>
                        <span className="commit-list-filters">
                          <label
                            className="commit-filter-toggle"
                            title="Show reviewed commits"
                          >
                            <input
                              type="checkbox"
                              className="visually-hidden"
                              checked={showReviewed}
                              onChange={(e) => setShowReviewed(e.target.checked)}
                            />
                            <CheckboxIcon checked={showReviewed} />
                            Reviewed
                          </label>
                          <label className="commit-filter-toggle" title="Show merge commits">
                            <input
                              type="checkbox"
                              className="visually-hidden"
                              checked={showMerges}
                              onChange={(e) => setShowMerges(e.target.checked)}
                            />
                            <CheckboxIcon checked={showMerges} />
                            Merges
                          </label>
                        </span>
                      </div>
                      {visibleCommits.length === 0 ? (
                        <p className="empty">No commits to show.</p>
                      ) : (
                        <div
                          className="commit-list-scroll"
                          onScroll={(e) => {
                            setCommitsScrolled(e.currentTarget.scrollTop > 0)
                          }}
                        >
                          <ol>
                            {commits.map((c) => {
                              if (!showReviewed && reviewedSet.has(c.sha)) return null
                              if (!showMerges && c.isMerge) return null
                              const commentCount = commentCountBySha.get(c.sha) ?? 0
                              return (
                                <li key={c.sha}>
                                  <button
                                    type="button"
                                    className={!branchView && c.sha === selectedSha ? 'active' : ''}
                                    onClick={() => {
                                      setSeedFilePath(null)
                                      setBranchView(false)
                                      setSelectedSha(c.sha)
                                      window.scrollTo(0, 0)
                                    }}
                                  >
                                    <span
                                      className={`idx${reviewedSet.has(c.sha) ? ' is-reviewed' : ''}`}
                                    >
                                      {reviewedSet.has(c.sha) ? (
                                        <CheckIcon
                                          className="commit-list-type-icon"
                                          title="Reviewed"
                                        />
                                      ) : c.isMerge ? (
                                        <MergeIcon
                                          className="commit-list-type-icon"
                                          title="Merge commit"
                                        />
                                      ) : (
                                        <CommitIcon
                                          className="commit-list-type-icon"
                                          title="Commit"
                                        />
                                      )}
                                    </span>
                                    <span className="subject">
                                      {messageEdits[c.sha]?.subject ?? c.subject}
                                    </span>
                                    <span className="sha-row">
                                      <span className="sha-row-main">
                                        <code className="sha">{c.shortSha}</code>
                                        {commentCount > 0 ? (
                                          <span
                                            className="commit-list-comments"
                                            title={`${commentCount} comment${
                                              commentCount === 1 ? '' : 's'
                                            }`}
                                          >
                                              <CommentBubbleIcon solid />
                                            <span>{commentCount}</span>
                                          </span>
                                        ) : null}
                                      </span>
                                      <DiffStat {...c.stats} />
                                    </span>
                                  </button>
                                </li>
                              )
                            })}
                          </ol>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          ) : null}
        </aside>

        <main className="main-pane">
          {noRepos ? (
            <p className="empty">No repos found in that directory.</p>
          ) : showSetupHint ? (
            <div className="setup-hint">
              <svg
                className="setup-hint-arrow"
                width="36"
                height="16"
                viewBox="0 0 36 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M34 8H6M10 3.5 4 8l6 4.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <p className="setup-hint-text">Select a review branch to begin</p>
            </div>
          ) : !meta || !ready ? (
            meta ? (
              <p className="muted setup-wait">Select a review branch to begin</p>
            ) : (
              <div className="page-loading" role="status" aria-live="polite">
                <span className="page-loading-spinner" aria-hidden="true" />
                <p className="page-loading-text">Loading repository…</p>
              </div>
            )
          ) : (branchView ? branchDiff : selected) ? (
            !branchView && diffLoading ? (
              <div className="page-loading" role="status" aria-live="polite">
                <span className="page-loading-spinner" aria-hidden="true" />
                <p className="page-loading-text">Loading diff…</p>
              </div>
            ) : (
              <CommitReview
                key={branchView ? `branch:${branchDiff?.baseSha}:${branchDiff?.headSha}` : selected?.sha}
                target={branchView && branchDiff ? {
                  kind: 'branch',
                  headSha: branchDiff.headSha,
                  baseSha: branchDiff.baseSha,
                  reviewBranch: reviewDraft,
                  baseBranch: baseDraft,
                } : { kind: 'commit', commit: selected! }}
                files={branchView ? branchDiff!.files : files}
                comments={comments}
                messageEdit={selected && !branchView ? messageEdits[selected.sha] : undefined}
                reviewed={Boolean(selected && !branchView && reviewedSet.has(selected.sha))}
                reviewedPaths={reviewedPaths}
                onReviewFileChange={(file) => {
                  setComments(file.comments)
                  setMessageEdits(file.messageEdits ?? {})
                  setReviewedShas(file.reviewedShas ?? [])
                  setReviewedPaths(file.reviewedPaths ?? {})
                }}
                initialFilePath={seedFilePath}
                onFilePathChange={setActiveFilePath}
                nav={{
                  index: selectedIndex,
                  total: commits.length,
                  canPrev: Boolean(prevVisible),
                  canNext: Boolean(nextVisible),
                  onPrev: () => {
                    if (!prevVisible) return
                    setSeedFilePath(null)
                    setSelectedSha(prevVisible.sha)
                    window.scrollTo(0, 0)
                  },
                  onNext: () => {
                    if (!nextVisible) return
                    setSeedFilePath(null)
                    setSelectedSha(nextVisible.sha)
                    window.scrollTo(0, 0)
                  },
                }}
              />
            )
          ) : (
            <p className="empty">Select a commit to review.</p>
          )}
        </main>
      </div>
    </div>
  )
}
