export type PullRequestRef = {
  owner: string
  repo: string
  number: number
  url: string
}

const URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/
/** Shorthand people paste from chat: owner/repo#123. */
const SHORTHAND_PATTERN = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/

export function refId(ref: Pick<PullRequestRef, 'owner' | 'repo' | 'number'>): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

function canonicalUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

export function parsePullRequestLine(line: string): PullRequestRef | null {
  const trimmed = line.trim().replace(/^[-*>\s]+/, '')
  if (trimmed === '') return null

  const match = URL_PATTERN.exec(trimmed) ?? SHORTHAND_PATTERN.exec(trimmed)
  if (match === null) return null

  const [, owner, repo, rawNumber] = match
  if (owner === undefined || repo === undefined || rawNumber === undefined) return null

  const number = Number.parseInt(rawNumber, 10)
  if (!Number.isSafeInteger(number) || number <= 0) return null

  const cleanRepo = repo.replace(/\.git$/, '')
  return { owner, repo: cleanRepo, number, url: canonicalUrl(owner, cleanRepo, number) }
}

export type ParseResult = {
  refs: PullRequestRef[]
  /** Lines that looked like content but were not pull request links. */
  skipped: string[]
}

/**
 * Read a pasted block. Unparseable lines are reported rather than dropped, so a
 * typo in one link does not silently shrink the queue.
 */
export function parsePullRequestList(text: string): ParseResult {
  const refs: PullRequestRef[] = []
  const skipped: string[] = []
  const seen = new Set<string>()

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const ref = parsePullRequestLine(line)
    if (ref === null) {
      skipped.push(line.trim())
      continue
    }
    const id = refId(ref)
    if (seen.has(id)) continue
    seen.add(id)
    refs.push(ref)
  }

  return { refs, skipped }
}
