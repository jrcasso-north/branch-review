/** Small view preferences that should outlive a navigation or a reload. */

const FILE_LIST_COLLAPSED_KEY = 'branch-review.fileListCollapsed'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === 'true'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Storage can be unavailable in private modes; the preference is optional.
  }
}

export function readFileListCollapsed(): boolean {
  return readFlag(FILE_LIST_COLLAPSED_KEY, false)
}

export function writeFileListCollapsed(value: boolean): void {
  writeFlag(FILE_LIST_COLLAPSED_KEY, value)
}
