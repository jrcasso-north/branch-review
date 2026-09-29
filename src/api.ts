import type {
  BaseSuggestion,
  BranchDiff,
  CommentsFile,
  CommitSummary,
  DiffFile,
  DiffStatCounts,
  EnqueueResult,
  MetaResponse,
  QueueFile,
  QueueItem,
  QueueStatus,
  RepoInfo,
  ReviewConfig,
} from './types'

const REPO_STORAGE_KEY = 'branch-review.repoPath'
const REPO_ROOT_STORAGE_KEY = 'branch-review.repoRoot'

let activeRepoPath: string | null = null

export function getActiveRepoPath(): string | null {
  return activeRepoPath
}

export function setActiveRepoPath(repoPath: string | null): void {
  activeRepoPath = repoPath
  if (repoPath) {
    localStorage.setItem(REPO_STORAGE_KEY, repoPath)
  } else {
    localStorage.removeItem(REPO_STORAGE_KEY)
  }
}

export function readStoredRepoPath(): string | null {
  return localStorage.getItem(REPO_STORAGE_KEY)
}

export function readStoredRepoRoot(): string | null {
  return localStorage.getItem(REPO_ROOT_STORAGE_KEY)
}

export function setStoredRepoRoot(root: string | null): void {
  if (root) {
    localStorage.setItem(REPO_ROOT_STORAGE_KEY, root)
  } else {
    localStorage.removeItem(REPO_ROOT_STORAGE_KEY)
  }
}

function withRepo(url: string): string {
  if (!activeRepoPath) return url
  const join = url.includes('?') ? '&' : '?'
  return `${url}${join}repo=${encodeURIComponent(activeRepoPath)}`
}

async function request<T>(apiPath: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (activeRepoPath) {
    headers['X-Repo-Path'] = activeRepoPath
  }

  const res = await fetch(withRepo(apiPath), {
    ...init,
    headers,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: string }).error)
        : `Request failed: ${res.status}`,
    )
  }
  return data as T
}

export type RepoListResponse = {
  roots: string[]
  fromCli: boolean
  repos: RepoInfo[]
  cancelled?: boolean
}

export async function fetchRepos() {
  const listed = await request<RepoListResponse>('/api/repos')
  if (listed.fromCli) {
    if (listed.roots[0]) setStoredRepoRoot(listed.roots[0])
    return listed
  }
  const storedRoot = readStoredRepoRoot()
  if (storedRoot) {
    try {
      const restored = await request<RepoListResponse>('/api/repo-roots', {
        method: 'PUT',
        body: JSON.stringify({ roots: [storedRoot] }),
      })
      if (restored.roots[0]) setStoredRepoRoot(restored.roots[0])
      return restored
    } catch {
      setStoredRepoRoot(null)
    }
  }
  return listed
}

export async function pickRepoRoot() {
  const listed = await request<RepoListResponse>('/api/repo-roots/pick', {
    method: 'POST',
  })
  if (!listed.cancelled && listed.roots[0]) {
    setStoredRepoRoot(listed.roots[0])
  }
  return listed
}

export function fetchMeta() {
  return request<MetaResponse>('/api/meta')
}

export function fetchSuggestedBase(reviewBranch: string) {
  return request<{
    reviewBranch: string
    suggestedBase: BaseSuggestion | null
  }>(`/api/suggest-base?reviewBranch=${encodeURIComponent(reviewBranch)}`)
}

export function saveConfig(config: ReviewConfig) {
  return request<{ config: ReviewConfig }>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

export function fetchCommits() {
  return request<{
    baseBranch: string
    reviewBranch: string
    commits: CommitSummary[]
    stats: DiffStatCounts
  }>('/api/commits')
}

export function fetchDiff(sha: string) {
  return request<{ sha: string; files: DiffFile[] }>(`/api/commits/${sha}/diff`)
}

export function fetchComments() {
  return request<CommentsFile>('/api/comments')
}

export function createComment(body: unknown) {
  return request<CommentsFile>('/api/comments', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateComment(
  id: string,
  patch: { body?: string; resolved?: boolean; dispatched?: boolean },
) {
  return request<CommentsFile>(`/api/comments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function setCommentResolved(id: string, resolved: boolean) {
  return updateComment(id, { resolved })
}

export function setCommentDispatched(id: string, dispatched: boolean) {
  return updateComment(id, { dispatched })
}

export function updateComments(
  ids: string[],
  patch: { body?: string; resolved?: boolean; dispatched?: boolean },
) {
  return request<CommentsFile>('/api/comments', {
    method: 'PATCH',
    body: JSON.stringify({ ids, ...patch }),
  })
}

export function setCommentsDispatched(ids: string[], dispatched: boolean) {
  return updateComments(ids, { dispatched })
}

export function removeComment(id: string) {
  return request<CommentsFile>(`/api/comments/${id}`, { method: 'DELETE' })
}

export function upsertMessageEdit(
  sha: string,
  patch: { subject?: string | null; body?: string | null },
) {
  return request<CommentsFile>(`/api/message-edits/${encodeURIComponent(sha)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function setReviewedFile(sha: string, path: string, reviewed: boolean) {
  return request<CommentsFile>(`/api/reviewed-files/${encodeURIComponent(sha)}`, {
    method: 'PUT',
    body: JSON.stringify({ path, reviewed }),
  })
}

export function setReviewed(sha: string, reviewed: boolean) {
  return request<CommentsFile>(`/api/reviewed/${encodeURIComponent(sha)}`, {
    method: 'PUT',
    body: JSON.stringify({ reviewed }),
  })
}

export function fetchBranchDiff(): Promise<BranchDiff> {
  return request<BranchDiff>('/api/branch-diff')
}

export function fetchQueue() {
  return request<QueueFile>('/api/queue')
}

export function enqueuePullRequests(text: string) {
  return request<EnqueueResult>('/api/queue', {
    method: 'POST',
    body: JSON.stringify({ text, addedBy: 'ui' }),
  })
}

export function activateQueueItem(id: string) {
  return request<{ queue: QueueFile; item: QueueItem }>('/api/queue/activate', {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

export function advanceQueue() {
  return request<{ queue: QueueFile; item?: QueueItem }>('/api/queue/next', {
    method: 'POST',
  })
}

export function setQueueItemBase(id: string, baseBranch: string) {
  return request<{ queue: QueueFile }>('/api/queue/base', {
    method: 'POST',
    body: JSON.stringify({ id, baseBranch }),
  })
}

export function setQueueItemStatus(id: string, status: QueueStatus) {
  return request<{ queue: QueueFile }>('/api/queue/status', {
    method: 'POST',
    body: JSON.stringify({ id, status }),
  })
}

export function removeQueueItem(id: string) {
  return request<{ queue: QueueFile }>('/api/queue/remove', {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
}

export function clearFinishedQueueItems() {
  return request<{ queue: QueueFile }>('/api/queue/clear-finished', { method: 'POST' })
}
