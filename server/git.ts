import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  readonly stderr?: string

  constructor(message: string, stderr?: string) {
    super(message)
    this.name = 'GitError'
    this.stderr = stderr
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    const err = error as { stderr?: string; message?: string }
    throw new GitError(err.message ?? 'git command failed', err.stderr)
  }
}

export async function assertGitRepo(repoPath: string): Promise<void> {
  const out = await git(repoPath, ['rev-parse', '--is-inside-work-tree'])
  if (out.trim() !== 'true') {
    throw new GitError('Not a git repository')
  }
}

/** Work tree root for any path inside a repo. `.branch-review/` lives here. */
export async function getRepoRoot(repoPath: string): Promise<string> {
  await assertGitRepo(repoPath)
  const root = (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim()
  if (!root) {
    throw new GitError('Could not resolve repository root')
  }
  return root
}

/** Remote URL, or null when the remote is not configured. */
export async function getRemoteUrl(
  repoPath: string,
  remote: string = 'origin',
): Promise<string | null> {
  try {
    const out = await git(repoPath, ['remote', 'get-url', remote])
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * Copy a pull request head into a local branch. GitHub exposes every PR at
 * `pull/<n>/head`, so this works without the API. `--force` keeps the branch
 * current when the PR is pushed to again.
 */
export async function fetchPullRequestHead(
  repoPath: string,
  number: number,
  localBranch: string,
): Promise<void> {
  await git(repoPath, [
    'fetch',
    '--force',
    'origin',
    `pull/${number}/head:${localBranch}`,
  ])
}

/** Branch checked out on disk, or null when HEAD is detached. */
export async function getCheckedOutBranch(repoPath: string): Promise<string | null> {
  const out = await git(repoPath, ['branch', '--show-current'])
  const branch = out.trim()
  return branch || null
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
      return true
    } catch {
      return false
    }
  }
}

async function resolveCommitish(repoPath: string, name: string): Promise<string> {
  try {
    return (await git(repoPath, [
      'rev-parse', '--verify', '--end-of-options', `${name}^{commit}`,
    ])).trim()
  } catch {
    return (await git(repoPath, [
      'rev-parse', '--verify', '--end-of-options', `origin/${name}^{commit}`,
    ])).trim()
  }
}

export type DiffStatCounts = {
  added: number
  removed: number
}

export type CommitSummary = {
  sha: string
  shortSha: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authoredAt: string
  isMerge: boolean
  stats: DiffStatCounts
}

function parseNumstatLines(lines: string[]): DiffStatCounts {
  let added = 0
  let removed = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [addRaw, delRaw] = trimmed.split('\t')
    if (addRaw && addRaw !== '-') added += Number(addRaw)
    if (delRaw && delRaw !== '-') removed += Number(delRaw)
  }
  return { added, removed }
}

async function listCommitStatsBySha(
  repoPath: string,
  baseSha: string,
  reviewSha: string,
): Promise<Map<string, DiffStatCounts>> {
  const stdout = await git(repoPath, [
    'log',
    '--reverse',
    '--numstat',
    '--format=%x1e%H',
    `${baseSha}..${reviewSha}`,
  ])
  const map = new Map<string, DiffStatCounts>()
  for (const chunk of stdout.split('\x1e')) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const sha = lines[0]!
    map.set(sha, parseNumstatLines(lines.slice(1)))
  }
  return map
}

export async function listCommitsNotInBase(
  repoPath: string,
  baseBranch: string,
  reviewBranch: string,
): Promise<CommitSummary[]> {
  const baseSha = await resolveCommitish(repoPath, baseBranch)
  const reviewSha = await resolveCommitish(repoPath, reviewBranch)
  const format = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%P'].join('%x1f') + '%x1e'
  const [stdout, statsBySha] = await Promise.all([
    git(repoPath, [
      'log',
      '--reverse',
      `--format=${format}`,
      `${baseSha}..${reviewSha}`,
    ]),
    listCommitStatsBySha(repoPath, baseSha, reviewSha),
  ])

  const records = stdout.split('\x1e').map((r) => r.trim()).filter(Boolean)
  return records.map((record) => {
    const [sha, shortSha, subject, body, authorName, authorEmail, authoredAt, parents] =
      record.split('\x1f')
    const parentCount = (parents ?? '').trim().split(/\s+/).filter(Boolean).length
    return {
      sha,
      shortSha,
      subject,
      body: (body ?? '').replace(/\n+$/, ''),
      authorName,
      authorEmail,
      authoredAt,
      isMerge: parentCount > 1,
      stats: statsBySha.get(sha!) ?? { added: 0, removed: 0 },
    }
  })
}

export type DiffLineType = 'added' | 'removed' | 'unchanged' | 'meta'

export type DiffLine = {
  type: DiffLineType
  content: string
  oldLine: number | null
  newLine: number | null
}

export type DiffFile = {
  path: string
  oldPath: string | null
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  lines: DiffLine[]
}

export async function getCommitDiff(repoPath: string, sha: string): Promise<DiffFile[]> {
  const stdout = await git(repoPath, [
    'show',
    '--format=',
    '--unified=3',
    '--find-renames',
    sha,
  ])
  return parseUnifiedDiff(stdout)
}

export type BranchDiff = {
  baseSha: string
  headSha: string
  files: DiffFile[]
}

export async function getSnapshotDiff(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<DiffFile[]> {
  if (![baseSha, headSha].every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
    throw new GitError('Diff snapshots require full commit SHAs')
  }
  const stdout = await git(repoPath, [
    'diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--find-renames',
    baseSha, headSha, '--',
  ])
  return parseUnifiedDiff(stdout)
}

export async function getBranchDiff(
  repoPath: string,
  baseBranch: string,
  reviewBranch: string,
): Promise<BranchDiff> {
  const baseTip = await resolveCommitish(repoPath, baseBranch)
  const headSha = await resolveCommitish(repoPath, reviewBranch)
  const baseSha = (await git(repoPath, ['merge-base', baseTip, headSha])).trim()
  return { baseSha, headSha, files: await getSnapshotDiff(repoPath, baseSha, headSha) }
}

/** Net line adds/removes for review tip vs base (three-dot range). */
export async function getRangeDiffStat(
  repoPath: string,
  baseBranch: string,
  reviewBranch: string,
): Promise<DiffStatCounts> {
  const baseSha = await resolveCommitish(repoPath, baseBranch)
  const reviewSha = await resolveCommitish(repoPath, reviewBranch)
  const stdout = await git(repoPath, ['diff', '--numstat', `${baseSha}...${reviewSha}`])
  return parseNumstatLines(stdout.split('\n'))
}

export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = []
  const chunks = diffText.split(/^diff --git /m).filter(Boolean)

  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const header = lines[0] ?? ''
    const match = /^a\/(.+) b\/(.+)$/.exec(header)
    if (!match) continue

    let oldPath = match[1]
    let newPath = match[2]
    let status: DiffFile['status'] = 'modified'

    for (const line of lines) {
      if (line.startsWith('new file mode')) status = 'added'
      if (line.startsWith('deleted file mode')) status = 'deleted'
      if (line.startsWith('rename from ')) {
        status = 'renamed'
        oldPath = line.slice('rename from '.length)
      }
      if (line.startsWith('rename to ')) {
        newPath = line.slice('rename to '.length)
      }
    }

    const path = status === 'deleted' ? oldPath : newPath
    const fileLines: DiffLine[] = []
    let oldLine = 0
    let newLine = 0

    for (const line of lines) {
      if (line.startsWith('@@')) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
        if (!hunk) continue
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        fileLines.push({
          type: 'meta',
          content: line,
          oldLine: null,
          newLine: null,
        })
        continue
      }

      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('old mode') ||
        line.startsWith('new mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('new file mode') ||
        line.startsWith('similarity index') ||
        line.startsWith('rename from') ||
        line.startsWith('rename to')
      ) {
        continue
      }

      if (line.startsWith('+')) {
        fileLines.push({
          type: 'added',
          content: line.slice(1),
          oldLine: null,
          newLine: newLine,
        })
        newLine += 1
      } else if (line.startsWith('-')) {
        fileLines.push({
          type: 'removed',
          content: line.slice(1),
          oldLine: oldLine,
          newLine: null,
        })
        oldLine += 1
      } else if (line.startsWith('\\')) {
        fileLines.push({
          type: 'meta',
          content: line,
          oldLine: null,
          newLine: null,
        })
      } else if (line.startsWith(' ') || line === '') {
        const content = line.startsWith(' ') ? line.slice(1) : line
        fileLines.push({
          type: 'unchanged',
          content,
          oldLine: oldLine,
          newLine: newLine,
        })
        oldLine += 1
        newLine += 1
      }
    }

    files.push({
      path,
      oldPath: oldPath === newPath ? null : oldPath,
      status,
      lines: fileLines,
    })
  }

  return files
}

/** Local heads and remote-tracking names (origin/ prefix stripped; remote-only). */
export type BranchLists = {
  local: string[]
  remote: string[]
}

export async function listBranches(repoPath: string): Promise<BranchLists> {
  const localOut = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ])
  const remoteOut = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/remotes',
  ])

  const local = new Set<string>()
  for (const line of localOut.split('\n')) {
    const name = line.trim()
    if (name) local.add(name)
  }

  const remote = new Set<string>()
  for (const line of remoteOut.split('\n')) {
    let name = line.trim()
    if (!name || name.endsWith('/HEAD')) continue
    if (name.startsWith('origin/')) name = name.slice('origin/'.length)
    else if (name.includes('/')) name = name.slice(name.indexOf('/') + 1)
    if (!name || local.has(name)) continue
    remote.add(name)
  }

  return {
    local: [...local].sort((a, b) => a.localeCompare(b)),
    remote: [...remote].sort((a, b) => a.localeCompare(b)),
  }
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const sym = (await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    const short = sym.replace(/^refs\/remotes\/origin\//, '')
    if (short) return short
  } catch {
    // fall through
  }
  for (const name of ['main', 'master']) {
    if (await branchExists(repoPath, name)) return name
  }
  return 'main'
}

export type BaseSuggestion = {
  baseBranch: string
  kind: 'stack' | 'default' | 'upstream'
  detail: string
}

/**
 * Infer a PR-style base for reviewBranch without checking it out.
 * Prefers: upstream tracking → nearest stacked local parent → default branch.
 */
export async function inferStackBaseBranch(
  repoPath: string,
  reviewBranch: string,
): Promise<BaseSuggestion | null> {
  const defaultBranch = await detectDefaultBranch(repoPath)

  let reviewSha: string
  try {
    reviewSha = await resolveCommitish(repoPath, reviewBranch)
  } catch {
    return null
  }

  try {
    const upstream = (
      await git(repoPath, ['rev-parse', '--abbrev-ref', `${reviewBranch}@{upstream}`])
    ).trim()
    const name = upstream.replace(/^origin\//, '')
    if (name && name !== reviewBranch && (await branchExists(repoPath, name))) {
      return {
        baseBranch: name,
        kind: name === defaultBranch ? 'default' : 'upstream',
        detail: `tracks ${upstream}`,
      }
    }
  } catch {
    // no upstream configured
  }

  let defaultSha: string
  try {
    defaultSha = await resolveCommitish(repoPath, defaultBranch)
  } catch {
    return {
      baseBranch: defaultBranch,
      kind: 'default',
      detail: `default branch ${defaultBranch}`,
    }
  }

  const locals = (await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  type Cand = { name: string; fromDefault: number; ahead: number }
  const cands: Cand[] = []

  for (const name of locals) {
    if (name === reviewBranch) continue
    try {
      const tip = (await git(repoPath, ['rev-parse', `${name}^{commit}`])).trim()
      await git(repoPath, ['merge-base', '--is-ancestor', tip, reviewSha])
      const fromDefault = Number(
        (await git(repoPath, ['rev-list', '--count', `${defaultSha}..${tip}`])).trim(),
      )
      const ahead = Number(
        (await git(repoPath, ['rev-list', '--count', `${tip}..${reviewSha}`])).trim(),
      )
      if (ahead === 0) continue
      cands.push({ name, fromDefault, ahead })
    } catch {
      // not an ancestor of the review tip
    }
  }

  if (cands.length === 0) {
    return {
      baseBranch: defaultBranch,
      kind: 'default',
      detail: `no stacked parent found; using ${defaultBranch}`,
    }
  }

  cands.sort((a, b) => b.fromDefault - a.fromDefault || a.ahead - b.ahead)
  const best = cands[0]!
  if (best.name === defaultBranch) {
    return {
      baseBranch: defaultBranch,
      kind: 'default',
      detail: `default branch ${defaultBranch}`,
    }
  }

  return {
    baseBranch: best.name,
    kind: 'stack',
    detail: `${best.ahead} commit(s) ahead of ${best.name}`,
  }
}

