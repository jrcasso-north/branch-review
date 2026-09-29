import path from 'node:path'
import { getRepoRoot, GitError } from '../server/git.js'

/**
 * Repository the tools act on. Claude Code starts the server with the project
 * directory as the cwd, so the cwd is the default. `BRANCH_REVIEW_REPO`
 * overrides that, and a per-call `repo` argument overrides both.
 */
export async function resolveRepo(requested?: string): Promise<string> {
  const raw =
    requested?.trim() || process.env.BRANCH_REVIEW_REPO?.trim() || process.cwd()
  const resolved = path.resolve(raw)

  try {
    return await getRepoRoot(resolved)
  } catch (error) {
    const detail =
      error instanceof GitError && error.stderr?.trim()
        ? ` (${error.stderr.trim().split('\n')[0]})`
        : ''
    throw new Error(
      `Could not resolve a git repository at ${resolved}${detail}. ` +
        'Pass a repo argument naming the repository you are reviewing. ' +
        'A workspace holding several repos is not itself a repo.',
    )
  }
}
