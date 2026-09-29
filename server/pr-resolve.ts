import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  branchExists,
  detectDefaultBranch,
  fetchPullRequestHead,
  getRemoteUrl,
  inferStackBaseBranch,
} from './git.js'
import { listRepos } from './repos.js'
import type { PullRequestRef } from './pr-url.js'

const execFileAsync = promisify(execFile)

/** Local branch a pull request is fetched into. Namespaced to avoid collisions. */
export function reviewBranchFor(number: number): string {
  return `review/pr-${number}`
}

const REMOTE_PATTERN = /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/

export function ownerRepoFromRemote(url: string): { owner: string; repo: string } | null {
  const match = REMOTE_PATTERN.exec(url.trim())
  if (match === null) return null
  const [, owner, repo] = match
  if (owner === undefined || repo === undefined) return null
  return { owner, repo }
}

/**
 * Find the checkout a pull request belongs to by matching its origin remote.
 * Directory names are not trusted: a clone can be renamed, and two roots can
 * hold repositories with the same basename.
 */
export async function findLocalClone(
  ref: PullRequestRef,
  roots: string[],
): Promise<string | null> {
  const repos = await listRepos(roots)

  for (const repo of repos) {
    const url = await getRemoteUrl(repo.path)
    if (url === null) continue
    const parsed = ownerRepoFromRemote(url)
    if (parsed === null) continue
    if (
      parsed.owner.toLowerCase() === ref.owner.toLowerCase() &&
      parsed.repo.toLowerCase() === ref.repo.toLowerCase()
    ) {
      return repo.path
    }
  }
  return null
}

export type PullRequestMeta = {
  title?: string
  author?: string
  baseBranch?: string
}

/** Extra detail from the GitHub CLI. Absent when gh is missing or not logged in. */
export async function readGhMetadata(ref: PullRequestRef): Promise<PullRequestMeta> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'view',
        String(ref.number),
        '--repo',
        `${ref.owner}/${ref.repo}`,
        '--json',
        'title,author,baseRefName',
      ],
      { encoding: 'utf8', timeout: 15_000 },
    )
    const parsed = JSON.parse(stdout) as {
      title?: string
      author?: { login?: string }
      baseRefName?: string
    }
    return {
      title: parsed.title,
      author: parsed.author?.login,
      baseBranch: parsed.baseRefName,
    }
  } catch {
    return {}
  }
}

export type ResolvedPullRequest = {
  repoPath: string
  reviewBranch: string
  baseBranch: string
  title?: string
  author?: string
}

/**
 * Turn a pull request reference into something reviewable: a local checkout, a
 * branch holding the PR head, and the branch it should be compared against.
 */
export async function resolvePullRequest(
  ref: PullRequestRef,
  roots: string[],
): Promise<ResolvedPullRequest> {
  const repoPath = await findLocalClone(ref, roots)
  if (repoPath === null) {
    throw new Error(
      `No local clone of ${ref.owner}/${ref.repo} under the scanned folders. Clone it, or point branch-review at the folder that holds it.`,
    )
  }

  const reviewBranch = reviewBranchFor(ref.number)
  await fetchPullRequestHead(repoPath, ref.number, reviewBranch)

  const meta = await readGhMetadata(ref)
  const baseBranch = await pickBaseBranch(repoPath, reviewBranch, meta.baseBranch)

  return {
    repoPath,
    reviewBranch,
    baseBranch,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.author === undefined ? {} : { author: meta.author }),
  }
}

/** Prefer what GitHub reports; fall back to the same inference the UI uses. */
async function pickBaseBranch(
  repoPath: string,
  reviewBranch: string,
  fromGh: string | undefined,
): Promise<string> {
  if (fromGh !== undefined && (await branchExists(repoPath, fromGh))) {
    return fromGh
  }
  const inferred = await inferStackBaseBranch(repoPath, reviewBranch)
  if (inferred !== null) return inferred.baseBranch
  return detectDefaultBranch(repoPath)
}
