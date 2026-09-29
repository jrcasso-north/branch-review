import { useEffect, useState } from 'react'
import {
  bundledLanguagesInfo,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
  type ThemedToken,
} from 'shiki'
import type { DiffFile } from './types'

const LIGHT_THEME = 'github-light'
const DARK_THEME = 'dracula'

export type LineTokens = ThemedToken[] | null

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [],
    })
  }
  return highlighterPromise
}

/** Warm the WASM engine early so the first diff paint is faster. */
export function prefetchHighlighter(): void {
  void getHighlighter()
}

const langByAlias: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const info of bundledLanguagesInfo) {
    map.set(info.id, info.id)
    for (const alias of info.aliases ?? []) {
      map.set(alias, info.id)
    }
  }
  // Extensions Shiki does not list as aliases
  map.set('svg', 'xml')
  map.set('htm', 'html')
  map.set('mjs', 'javascript')
  map.set('cjs', 'javascript')
  map.set('mts', 'typescript')
  map.set('cts', 'typescript')
  map.set('pyi', 'python')
  map.set('pyx', 'python')
  map.set('gql', 'graphql')
  map.set('tf', 'terraform')
  map.set('tfvars', 'terraform')
  map.set('hbs', 'handlebars')
  map.set('njk', 'jinja')
  return map
})()

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  gemfile: 'ruby',
  rakefile: 'ruby',
  brewfile: 'ruby',
  podfile: 'ruby',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.development': 'dotenv',
  '.env.production': 'dotenv',
  '.env.test': 'dotenv',
  'cmakelists.txt': 'cmake',
}

export function languageForPath(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop() ?? path
  const lower = base.toLowerCase()

  if (SPECIAL_NAMES[lower]) return SPECIAL_NAMES[lower]
  if (lower.startsWith('.env.')) return 'dotenv'
  if (lower.startsWith('dockerfile')) return 'docker'

  const dot = lower.indexOf('.')
  if (dot < 0) return langByAlias.get(lower)

  // Longest compound suffix first: foo.svelte.ts → svelte.ts → ts
  const afterFirst = lower.slice(dot + 1)
  const parts = afterFirst.split('.')
  for (let i = 0; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    const lang = langByAlias.get(ext)
    if (lang) return lang
  }
  return undefined
}

async function ensureLanguage(lang: string): Promise<boolean> {
  const highlighter = await getHighlighter()
  if (highlighter.getLoadedLanguages().includes(lang)) return true
  try {
    await highlighter.loadLanguage(lang as BundledLanguage)
    return true
  } catch {
    return false
  }
}

function tokenize(code: string, lang: string, highlighter: Highlighter): ThemedToken[][] {
  return highlighter.codeToTokens(code, {
    lang: lang as BundledLanguage,
    themes: {
      light: LIGHT_THEME,
      dark: DARK_THEME,
    },
    defaultColor: 'light-dark()',
  }).tokens
}

/**
 * Highlight one hunk (lines between @@ delimiters). Token state must not cross
 * hunk boundaries — the skipped file context between hunks is not in the diff.
 */
function highlightHunk(
  lines: DiffFile['lines'],
  start: number,
  end: number,
  lang: string,
  highlighter: Highlighter,
  out: LineTokens[],
): void {
  const oldParts: string[] = []
  const newParts: string[] = []
  const oldMap: (number | null)[] = []
  const newMap: (number | null)[] = []

  for (let i = start; i < end; i++) {
    const line = lines[i]!
    if (line.type === 'added') {
      oldMap.push(null)
      newMap.push(newParts.length)
      newParts.push(line.content)
    } else if (line.type === 'removed') {
      oldMap.push(oldParts.length)
      newMap.push(null)
      oldParts.push(line.content)
    } else {
      oldMap.push(oldParts.length)
      newMap.push(newParts.length)
      oldParts.push(line.content)
      newParts.push(line.content)
    }
  }

  const oldTokens =
    oldParts.length === 0 ? [] : tokenize(oldParts.join('\n'), lang, highlighter)
  const newTokens =
    newParts.length === 0 ? [] : tokenize(newParts.join('\n'), lang, highlighter)

  for (let i = 0; i < end - start; i++) {
    const line = lines[start + i]!
    const displayIndex = start + i
    if (line.type === 'removed') {
      const idx = oldMap[i]
      out[displayIndex] = idx === null ? null : (oldTokens[idx] ?? [])
    } else {
      const idx = newMap[i]
      out[displayIndex] = idx === null ? null : (newTokens[idx] ?? [])
    }
  }
}

/**
 * Highlight a unified diff per hunk. Each @@ section is tokenized on its own so
 * grammar state does not bleed across omitted context. Returns null when the
 * path has no language or highlighting fails (caller shows plain text).
 */
export async function highlightDiffFile(file: DiffFile): Promise<LineTokens[] | null> {
  const lang = languageForPath(file.path)
  if (!lang) return null
  if (!(await ensureLanguage(lang))) return null

  const highlighter = await getHighlighter()
  const out: LineTokens[] = file.lines.map(() => null)

  try {
    let hunkStart = -1
    for (let i = 0; i <= file.lines.length; i++) {
      const line = file.lines[i]
      const isBoundary = i === file.lines.length || line?.type === 'meta'
      if (isBoundary) {
        if (hunkStart >= 0 && hunkStart < i) {
          highlightHunk(file.lines, hunkStart, i, lang, highlighter, out)
        }
        hunkStart = -1
        continue
      }
      if (hunkStart < 0) hunkStart = i
    }
  } catch {
    return null
  }

  return out
}

/** Async highlight for one diff file; null while loading or when unavailable. */
export function useHighlightedDiff(file: DiffFile): LineTokens[] | null {
  const [state, setState] = useState<{
    path: string
    lines: DiffFile['lines']
    tokens: LineTokens[] | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void highlightDiffFile(file).then((result) => {
      if (cancelled) return
      setState({ path: file.path, lines: file.lines, tokens: result })
    })
    return () => {
      cancelled = true
    }
  }, [file])

  if (state?.path !== file.path || state.lines !== file.lines) return null
  return state.tokens
}
