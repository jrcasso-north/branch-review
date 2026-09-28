import path from 'node:path'
import { getRepoRoot } from '../server/git.js'

/**
 * Repository the tools act on. Claude Code starts the server with the project
 * directory as the cwd, so the cwd is the default. `BRANCH_REVIEW_REPO`
 * overrides that, and a per-call `repo` argument overrides both.
 */
export function resolveRepo(requested?: string): Promise<string> {
  const raw =
    requested?.trim() || process.env.BRANCH_REVIEW_REPO?.trim() || process.cwd()
  return getRepoRoot(path.resolve(raw))
}
