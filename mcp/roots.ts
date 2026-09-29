import path from 'node:path'
import { resolveRepo } from './repo.js'

/**
 * Folders searched for the checkout a queued pull request belongs to. By
 * default the parent of the current repository, which is where sibling clones
 * live. `BRANCH_REVIEW_ROOTS` overrides it with a path-separated list.
 */
export async function resolveRoots(): Promise<string[]> {
  const override = process.env.BRANCH_REVIEW_ROOTS?.trim()
  if (override) {
    return override
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => path.resolve(entry))
  }

  try {
    const repoPath = await resolveRepo()
    return [path.dirname(repoPath)]
  } catch {
    return [path.resolve(process.cwd())]
  }
}
