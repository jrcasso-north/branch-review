export type ViewUrlState = {
  repoName: string | null
  reviewBranch: string | null
  baseBranch: string | null
  commitSha: string | null
  filePath: string | null
}

const BRANCH_SEP = '...'

export function parseViewUrl(
  pathname = window.location.pathname,
  hash = window.location.hash,
): ViewUrlState {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  if (!trimmed) {
    return {
      repoName: null,
      reviewBranch: null,
      baseBranch: null,
      commitSha: null,
      filePath: filePathFromHash(hash),
    }
  }

  const parts = trimmed.split('/')
  const repoName = safeDecode(parts[0] ?? '')
  if (parts.length === 1) {
    return {
      repoName,
      reviewBranch: null,
      baseBranch: null,
      commitSha: null,
      filePath: filePathFromHash(hash),
    }
  }

  const shaCandidate = parts[parts.length - 1] ?? ''
  const looksLikeSha = /^[0-9a-f]{7,40}$/i.test(shaCandidate)
  const branchPart = looksLikeSha
    ? parts.slice(1, -1).join('/')
    : parts.slice(1).join('/')
  const commitSha = looksLikeSha ? safeDecode(shaCandidate) : null

  const sepAt = branchPart.indexOf(BRANCH_SEP)
  if (sepAt === -1) {
    return {
      repoName,
      reviewBranch: null,
      baseBranch: null,
      commitSha,
      filePath: filePathFromHash(hash),
    }
  }

  return {
    repoName,
    reviewBranch: safeDecode(branchPart.slice(0, sepAt)),
    baseBranch: safeDecode(branchPart.slice(sepAt + BRANCH_SEP.length)),
    commitSha,
    filePath: filePathFromHash(hash),
  }
}

export function buildViewUrl(state: {
  repoName: string
  reviewBranch?: string | null
  baseBranch?: string | null
  commitSha?: string | null
  filePath?: string | null
}): string {
  const { repoName, reviewBranch, baseBranch, commitSha, filePath } = state
  let path = `/${encodeURIComponent(repoName)}`
  if (reviewBranch && baseBranch) {
    path += `/${encodeURIComponent(reviewBranch)}${BRANCH_SEP}${encodeURIComponent(baseBranch)}`
    if (commitSha) {
      path += `/${encodeURIComponent(commitSha)}`
    }
  }
  if (filePath && reviewBranch && baseBranch) {
    path += `#${encodeURIComponent(filePath)}`
  }
  return path
}

export function replaceViewUrl(state: {
  repoName: string
  reviewBranch?: string | null
  baseBranch?: string | null
  commitSha?: string | null
  filePath?: string | null
}): void {
  const next = buildViewUrl(state)
  const current = `${window.location.pathname}${window.location.hash}`
  if (current === next) return
  window.history.replaceState(null, '', next)
}

function filePathFromHash(hash: string): string | null {
  if (!hash || hash === '#') return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const decoded = safeDecode(raw)
  return decoded || null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
