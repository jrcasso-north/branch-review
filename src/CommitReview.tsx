import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import type {
  Comment,
  CommentsFile,
  CommitSummary,
  DiffFile,
  FileComment,
  LineComment,
  LineType,
  MessageEdit,
} from './types'
import { createComment, removeComment, setCommentDispatched, setCommentResolved, setCommentsDispatched, setReviewed, setReviewedFile, updateComment, upsertMessageEdit } from './api'
import { sendableOnCommit } from './comments'
import { readFileListCollapsed, writeFileListCollapsed } from './prefs'
import { buildFileTree, collectDirPaths, type FileTreeNode } from './fileTree'
import {
  AgentIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CheckboxIcon,
  CommentBubbleIcon,
  CommitIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  StatusIcon,
  TrashIcon,
  UndoIcon,
} from './icons'
import { useHighlightedDiff, type LineTokens } from './highlight'
import { countFileDiffStats, DiffStat, sumDiffStats } from './DiffStat'
import {
  hideWhitespaceOnlyChanges,
  readStoredShowWhitespace,
  writeStoredShowWhitespace,
} from './whitespaceDiff'
import type { ThemedToken } from 'shiki'

function isSaveShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey)
}

function DraftActions({
  busy = false,
  saveDisabled = false,
  onSave,
  onCancel,
  onReset,
  onDelete,
}: {
  busy?: boolean
  saveDisabled?: boolean
  onSave: () => void
  onCancel: () => void
  onReset?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="draft-actions">
      <button
        type="button"
        className="btn"
        disabled={busy || saveDisabled}
        onClick={onSave}
      >
        Save
      </button>
      <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      {onReset ? (
        <button type="button" className="draft-reset" disabled={busy} onClick={onReset}>
          Reset
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="comment-icon-btn comment-delete-btn"
          title="Delete comment"
          aria-label="Delete comment"
          disabled={busy}
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
      ) : null}
    </div>
  )
}

type Props = {
  target:
    | { kind: 'commit'; commit: CommitSummary }
    | {
        kind: 'branch'
        headSha: string
        baseSha: string
        reviewBranch: string
        baseBranch: string
      }
  files: DiffFile[]
  comments: Comment[]
  messageEdit: MessageEdit | undefined
  reviewed: boolean
  reviewedPaths: Record<string, string[]>
  onReviewFileChange: (file: CommentsFile) => void
  initialFilePath?: string | null
  onFilePathChange?: (path: string | null) => void
  nav: {
    index: number
    total: number
    onPrev: () => void
    onNext: () => void
    canPrev?: boolean
    canNext?: boolean
  }
}

function fileAnchorId(path: string): string {
  return `file-diff-${encodeURIComponent(path)}`
}

function commentDomId(id: string): string {
  return `review-comment-${id}`
}

function scrollToCommentElement(id: string) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document
        .getElementById(commentDomId(id))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  })
}

/** Open file then line comments for one path, in visual order. */
function orderedOpenCommentIdsForFile(
  file: DiffFile,
  fileComments: FileComment[],
  lineComments: LineComment[],
  showWhitespace: boolean,
): string[] {
  const lines = showWhitespace ? file.lines : hideWhitespaceOnlyChanges(file.lines)
  const openFileIds = fileComments.filter((c) => !isCommentResolved(c)).map((c) => c.id)
  const openLine = lineComments.filter((c) => !isCommentResolved(c))
  const orderedLineIds: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    for (const c of openLine) {
      if (seen.has(c.id)) continue
      if (!isCommentAnchorRow(c, file.path, lines, i)) continue
      orderedLineIds.push(c.id)
      seen.add(c.id)
    }
  }
  for (const c of openLine) {
    if (!seen.has(c.id)) orderedLineIds.push(c.id)
  }
  return [...openFileIds, ...orderedLineIds]
}

function CommitBodyDisplay({ body }: { body: string }) {
  const clipRef = useRef<HTMLDivElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [needsToggle, setNeedsToggle] = useState(false)

  useLayoutEffect(() => {
    setExpanded(false)
    setNeedsToggle(false)
  }, [body])

  useLayoutEffect(() => {
    if (expanded) return
    const clip = clipRef.current
    const pre = preRef.current
    if (!clip || !pre) return
    setNeedsToggle(pre.scrollHeight > clip.clientHeight + 1)
  }, [body, expanded])

  return (
    <div className="commit-body-wrap">
      <div
        ref={clipRef}
        className={`commit-body-clip${expanded ? '' : ' is-clamped'}${
          !expanded && needsToggle ? ' is-faded' : ''
        }`}
      >
        <pre ref={preRef} className="commit-body">
          {body}
        </pre>
      </div>
      {needsToggle || expanded ? (
        <button
          type="button"
          className="btn link commit-body-toggle"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}

function EditableCommitText({
  kind,
  original,
  edited,
  busy,
  onSave,
  onReset,
}: {
  kind: 'subject' | 'body'
  original: string
  edited: string | undefined
  busy: boolean
  onSave: (value: string) => Promise<void>
  onReset: () => Promise<void>
}) {
  const display = edited ?? original
  const isEdited = edited !== undefined
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(display)
  const editorRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!editing) setDraft(display)
  }, [display, editing])

  useEffect(() => {
    setEditing(false)
  }, [original, edited])

  useLayoutEffect(() => {
    if (!editing) return
    const el = editorRef.current
    if (!el) return
    el.textContent = display
    el.focus()
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    // Seed once when editing starts; `display` is from that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  function readEditorValue(): string {
    const el = editorRef.current
    if (!el) return draft
    return (el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ')
  }

  async function save() {
    const raw = readEditorValue()
    const next = kind === 'subject' ? raw.trim() : raw.replace(/\n+$/, '')
    if (kind === 'subject' && !next) return
    if (next === original) {
      if (isEdited) await onReset()
      setEditing(false)
      return
    }
    if (next === display) {
      setEditing(false)
      return
    }
    await onSave(next)
    setEditing(false)
  }

  function cancel() {
    setEditing(false)
    setDraft(display)
  }

  function beginEdit() {
    if (busy) return
    setDraft(display)
    setEditing(true)
  }

  function onEditorInput() {
    setDraft(readEditorValue())
  }

  function onEditorKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
      return
    }
    if (kind === 'subject' && e.key === 'Enter') {
      e.preventDefault()
      if (!busy) void save()
      return
    }
    if (kind === 'body' && e.key === 'Enter') {
      e.preventDefault()
      document.execCommand('insertText', false, '\n')
      setDraft(readEditorValue())
      return
    }
    if (!isSaveShortcut(e)) return
    e.preventDefault()
    if (!busy) void save()
  }

  function onEditorPaste(e: ClipboardEvent<HTMLElement>) {
    e.preventDefault()
    let text = e.clipboardData.getData('text/plain')
    if (kind === 'subject') text = text.replace(/\s+/g, ' ')
    document.execCommand('insertText', false, text)
    setDraft(readEditorValue())
  }

  const contentClass = [
    'commit-display-content',
    isEdited ? 'is-edited' : '',
    editing ? 'is-editing' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={`commit-display commit-display-${kind}${editing ? ' is-editing' : ''}`}
    >
      <div
        className="commit-display-main"
        role={editing ? undefined : 'button'}
        tabIndex={editing ? undefined : 0}
        onClick={
          editing
            ? undefined
            : (e) => {
                if ((e.target as HTMLElement).closest('button')) return
                beginEdit()
              }
        }
        onKeyDown={
          editing
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  beginEdit()
                }
              }
        }
      >
        <div className={contentClass}>
          {!editing ? (
            <span
              className={`commit-edit-chip${isEdited ? ' is-edited' : ''}`}
              title={isEdited ? `Original: ${original || '(empty)'}` : undefined}
              aria-hidden={isEdited ? undefined : true}
            />
          ) : null}
          {kind === 'subject' ? (
            <h2
              ref={editorRef as RefObject<HTMLHeadingElement | null>}
              contentEditable={editing}
              suppressContentEditableWarning
              spellCheck={editing}
              aria-label="Commit subject"
              aria-multiline={false}
              role={editing ? 'textbox' : undefined}
              onInput={editing ? onEditorInput : undefined}
              onKeyDown={editing ? onEditorKeyDown : undefined}
              onPaste={editing ? onEditorPaste : undefined}
            >
              {editing ? null : display}
            </h2>
          ) : editing ? (
            <pre
              ref={editorRef as RefObject<HTMLPreElement | null>}
              className="commit-body"
              contentEditable
              suppressContentEditableWarning
              spellCheck
              aria-label="Commit description"
              aria-multiline
              role="textbox"
              onInput={onEditorInput}
              onKeyDown={onEditorKeyDown}
              onPaste={onEditorPaste}
            />
          ) : display ? (
            <CommitBodyDisplay body={display} />
          ) : (
            <p className="muted commit-body-empty">No message body</p>
          )}
        </div>
      </div>
      {editing ? (
        <div className="commit-edit-toolbar">
          <DraftActions
            busy={busy}
            saveDisabled={kind === 'subject' && !draft.trim()}
            onSave={() => void save()}
            onCancel={cancel}
            onReset={
              isEdited
                ? () => {
                    void onReset().then(() => {
                      setEditing(false)
                      setDraft(original)
                    })
                  }
                : undefined
            }
          />
        </div>
      ) : null}
    </div>
  )
}

function lineNumberFor(line: DiffFile['lines'][number]): number | null {
  if (line.type === 'removed') return line.oldLine
  if (line.type === 'added' || line.type === 'unchanged') return line.newLine
  return null
}

function commentStartLine(comment: LineComment): number {
  if (comment.startLine !== undefined) return comment.startLine
  // Recover multi-line extent when startLine was omitted but snippet has N lines.
  if (comment.snippet) {
    const extraLines = comment.snippet.split('\n').length - 1
    if (extraLines > 0) return Math.max(1, comment.line - extraLines)
  }
  return comment.line
}

function isCommentableLine(
  line: DiffFile['lines'][number],
): line is DiffFile['lines'][number] & { type: LineType } {
  return line.type === 'added' || line.type === 'removed' || line.type === 'unchanged'
}

/**
 * Farthest display index from `anchorIdx` toward `targetIdx` that stays a
 * contiguous run of the same commentable `lineType` (no meta / other sides).
 */
function contiguousRangeEnd(
  lines: DiffFile['lines'],
  anchorIdx: number,
  targetIdx: number,
  lineType: LineType,
): number {
  if (targetIdx === anchorIdx) return anchorIdx
  const step = targetIdx > anchorIdx ? 1 : -1
  let end = anchorIdx
  for (let i = anchorIdx + step; step > 0 ? i <= targetIdx : i >= targetIdx; i += step) {
    const line = lines[i]
    if (!line || !isCommentableLine(line) || line.type !== lineType) break
    if (lineNumberFor(line) === null) break
    end = i
  }
  return end
}

function rangeSnippet(lines: DiffFile['lines'], startIdx: number, endIdx: number): string {
  const lo = Math.min(startIdx, endIdx)
  const hi = Math.max(startIdx, endIdx)
  const parts: string[] = []
  for (let i = lo; i <= hi; i++) {
    const line = lines[i]
    if (!line || !isCommentableLine(line)) continue
    parts.push(line.content)
  }
  return parts.join('\n')
}

function LineCode({
  content,
  tokens,
}: {
  content: string
  tokens: ThemedToken[] | null | undefined
}) {
  if (!tokens) {
    return <pre className="line-code">{content || ' '}</pre>
  }
  if (tokens.length === 0) {
    return <pre className="line-code">{' '}</pre>
  }
  return (
    <pre className="line-code">
      {tokens.map((token, i) => (
        <span key={i} style={token.htmlStyle as CSSProperties | undefined}>
          {token.content}
        </span>
      ))}
    </pre>
  )
}

function isLineInCommentRange(
  comment: LineComment,
  filePath: string,
  line: DiffFile['lines'][number],
): boolean {
  if (comment.path !== filePath) return false
  if (comment.lineType !== line.type) return false
  const n = lineNumberFor(line)
  if (n === null) return false
  return n >= commentStartLine(comment) && n <= comment.line
}

/**
 * True for the last display row that belongs to this comment's line range.
 * Prefer this over line-number equality so the thread sits under the bottom
 * of the highlighted block even if line numbers are unusual.
 */
function isCommentAnchorRow(
  comment: LineComment,
  filePath: string,
  lines: DiffFile['lines'],
  idx: number,
): boolean {
  const line = lines[idx]
  if (!line || !isLineInCommentRange(comment, filePath, line)) return false
  for (let j = idx + 1; j < lines.length; j++) {
    const later = lines[j]
    if (!later || later.type === 'meta') continue
    if (isLineInCommentRange(comment, filePath, later)) return false
    // Contiguous same-type ranges never resume after a gap of other lines.
    if (isCommentableLine(later)) break
  }
  return true
}

/**
 * Inclusive display-index span for a line comment: contiguous same-type rows
 * from the first in-range line through the anchor row.
 */
function commentDisplayRange(
  comment: LineComment,
  filePath: string,
  lines: DiffFile['lines'],
): { lo: number; hi: number } | null {
  if (comment.path !== filePath) return null
  let hi = -1
  for (let i = 0; i < lines.length; i++) {
    if (isCommentAnchorRow(comment, filePath, lines, i)) {
      hi = i
      break
    }
  }
  if (hi < 0) return null

  const startNo = commentStartLine(comment)
  const endNo = comment.line
  let lo = hi
  for (let i = hi - 1; i >= 0; i--) {
    const row = lines[i]
    if (!row || !isCommentableLine(row) || row.type !== comment.lineType) break
    const n = lineNumberFor(row)
    if (n === null || n < startNo || n > endNo) break
    lo = i
  }
  return { lo, hi }
}

function formatCommitTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })
}

/** Calendar-day label for comment headers. */
function formatCommentHeaderWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Comment from unknown date'
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfDay = new Date(date)
  startOfDay.setHours(0, 0, 0, 0)
  const days = Math.round((startOfToday.getTime() - startOfDay.getTime()) / 86_400_000)
  if (days <= 0) return 'Commented today'
  if (days === 1) return 'Commented yesterday'
  if (days < 30) return `Commented ${days} days ago`
  const absolute = date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  return `Comment from ${absolute}`
}

function isCommentResolved(comment: Comment): boolean {
  return comment.resolved === true
}

function isCommentDispatched(comment: Comment): boolean {
  return comment.dispatched === true
}

function commentPreview(body: string): string {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}

function EditableComment({
  comment,
  busy,
  onSave,
  onResolve,
  onDispatch,
  onDelete,
  onHoverChange,
  className,
}: {
  comment: Comment
  busy: boolean
  onSave: (id: string, body: string) => Promise<void>
  onResolve: (id: string, resolved: boolean) => Promise<void>
  onDispatch: (id: string, dispatched: boolean) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onHoverChange?: (id: string | null) => void
  className?: string
}) {
  const resolved = isCommentResolved(comment)
  const dispatched = isCommentDispatched(comment)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(!resolved)
  const [draft, setDraft] = useState(comment.body)

  useEffect(() => {
    if (!editing) setDraft(comment.body)
  }, [comment.body, editing])

  useEffect(() => {
    if (resolved) {
      setExpanded(false)
      setEditing(false)
    } else {
      setExpanded(true)
    }
  }, [resolved, comment.id])

  async function save() {
    if (!draft.trim() || draft.trim() === comment.body) {
      setEditing(false)
      setDraft(comment.body)
      return
    }
    await onSave(comment.id, draft.trim())
    setEditing(false)
  }

  function beginEdit() {
    if (busy || resolved) return
    setDraft(comment.body)
    setEditing(true)
    setExpanded(true)
  }

  const threadClass = [
    'comment-thread',
    editing ? 'is-editing' : '',
    resolved ? 'is-resolved' : '',
    resolved && !expanded ? 'is-collapsed' : '',
    dispatched && !resolved ? 'is-dispatched' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      id={commentDomId(comment.id)}
      className={threadClass}
      onMouseEnter={() => onHoverChange?.(comment.id)}
      onMouseLeave={() => onHoverChange?.(null)}
    >
      <div className="comment-view" aria-hidden={editing || undefined}>
        <div className="comment-header">
          {resolved && !expanded ? (
            <span className="comment-header-label comment-resolved-heading">Resolved</span>
          ) : (
            <span className="comment-header-label" title={formatCommitTime(comment.createdAt)}>
              {formatCommentHeaderWhen(comment.createdAt)}
            </span>
          )}
          <div className="comment-view-actions">
            {resolved ? (
              <span className="comment-icon-slot" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className="comment-icon-btn comment-edit-btn"
                title="Edit comment"
                aria-label="Edit comment"
                disabled={busy || editing}
                onClick={beginEdit}
              >
                <EditIcon />
              </button>
            )}
            {resolved ? (
              <span className="comment-icon-slot" aria-hidden="true" />
            ) : (
              <button
                type="button"
                className={`comment-icon-btn comment-dispatch-btn${dispatched ? ' is-dispatched' : ''}`}
                title={dispatched ? 'Waiting for the agent. Click to take it back.' : 'Send to agent'}
                aria-label={dispatched ? 'Take back from agent' : 'Send to agent'}
                aria-pressed={dispatched}
                disabled={busy || editing}
                onClick={() => void onDispatch(comment.id, !dispatched)}
              >
                <AgentIcon />
              </button>
            )}
            <button
              type="button"
              className={`comment-icon-btn comment-resolve-btn${resolved ? ' is-resolved' : ''}`}
              title={resolved ? 'Reopen comment' : 'Resolve comment'}
              aria-label={resolved ? 'Reopen comment' : 'Resolve comment'}
              disabled={busy || editing}
              onClick={() => void onResolve(comment.id, !resolved)}
            >
              {resolved ? <UndoIcon /> : <CheckIcon />}
            </button>
            {resolved ? (
              <button
                type="button"
                className="comment-icon-btn comment-expand-btn"
                title={expanded ? 'Collapse resolved comment' : 'Expand resolved comment'}
                aria-label={expanded ? 'Collapse resolved comment' : 'Expand resolved comment'}
                aria-expanded={expanded}
                disabled={busy || editing}
                onClick={() => setExpanded((prev) => !prev)}
              >
                <span
                  className={`comment-chevron-wrap${expanded ? ' is-open' : ''}`}
                  aria-hidden="true"
                >
                  <span className="comment-chevron" />
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="comment-icon-btn comment-delete-btn"
                title="Delete comment"
                aria-label="Delete comment"
                disabled={busy || editing}
                onClick={() => {
                  if (!window.confirm('Delete this comment?')) return
                  void onDelete(comment.id)
                }}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
        {resolved && !expanded ? (
          <button
            type="button"
            className="comment-body-hit comment-resolved-summary"
            disabled={busy}
            onClick={() => setExpanded(true)}
          >
            <span className="comment-resolved-preview">{commentPreview(comment.body)}</span>
          </button>
        ) : (
          <button
            type="button"
            className="comment-body-hit"
            disabled={busy || editing || resolved}
            onClick={resolved ? undefined : beginEdit}
          >
            {comment.body}
          </button>
        )}
      </div>
      {editing ? (
        <div className="compose-panel comment-edit-overlay">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
            onKeyDown={(e) => {
              if (!isSaveShortcut(e)) return
              e.preventDefault()
              if (!busy) void save()
            }}
          />
          <DraftActions
            busy={busy}
            onSave={() => void save()}
            onCancel={() => {
              setEditing(false)
              setDraft(comment.body)
            }}
            onDelete={() => {
              if (!window.confirm('Delete this comment?')) return
              void onDelete(comment.id)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}


type NameHover = {
  text: string
  path: string
  kind: 'file' | 'dir'
  rowTop: number
  rowLeft: number
  rowHeight: number
  rowWidth: number
  textLeft: number
  textTop: number
  textHeight: number
  rails: { left: number }[]
}

function FileTree({
  nodes,
  depth,
  activePath,
  expanded,
  commentCounts,
  overflowHoverPath,
  onToggleDir,
  onSelectFile,
  onNameHover,
  onNameLeave,
}: {
  nodes: FileTreeNode[]
  depth: number
  activePath: string | undefined
  expanded: Set<string>
  commentCounts: Map<string, number>
  overflowHoverPath: string | null
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
  onNameHover: (
    event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>,
    path: string,
    text: string,
    kind: 'file' | 'dir',
  ) => void
  onNameLeave: () => void
}) {
  return (
    <ul className={depth === 0 ? 'file-tree' : 'file-tree-nested'} role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        // Indent content; hover/active fill starts after the horizontal branch tip.
        const padLeft = `${0.45 + depth * 0.7}rem`
        const branchLeftRem = depth > 0 ? 0.45 + (depth - 1) * 0.7 + 0.28 : 0
        const branchWidthRem = 0.95
        const hoverInset =
          depth > 0 ? `${branchLeftRem + branchWidthRem}rem` : '0px'
        const rowStyle = {
          paddingLeft: padLeft,
          ['--tree-hover-inset' as string]: hoverInset,
        }

        if (node.kind === 'dir') {
          const isOpen = expanded.has(node.path)
          const railLeft = `${0.45 + depth * 0.7 + 0.28}rem`
          const label = `${node.name}/`
          const isOverflowHover = overflowHoverPath === node.path
          return (
            <li key={`dir:${node.path}`} role="treeitem" aria-expanded={isOpen}>
              <button
                type="button"
                className={`file-tree-dir${isOverflowHover ? ' is-overflow-hover' : ''}`}
                style={rowStyle}
                aria-expanded={isOpen}
                onClick={() => onToggleDir(node.path)}
                onMouseEnter={(e) => onNameHover(e, node.path, label, 'dir')}
                onMouseLeave={onNameLeave}
                onFocus={(e) => onNameHover(e, node.path, label, 'dir')}
                onBlur={onNameLeave}
              >
                <span className="file-tree-chevron" aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                <FolderIcon className="file-tree-icon" />
                <span className="file-tree-name">{label}</span>
              </button>
              {isOpen ? (
                <div className="file-tree-children">
                  <span className="file-tree-rail" style={{ left: railLeft }} aria-hidden="true" />
                  <FileTree
                    nodes={node.children}
                    depth={depth + 1}
                    activePath={activePath}
                    expanded={expanded}
                    commentCounts={commentCounts}
                    overflowHoverPath={overflowHoverPath}
                    onToggleDir={onToggleDir}
                    onSelectFile={onSelectFile}
                    onNameHover={onNameHover}
                    onNameLeave={onNameLeave}
                  />
                </div>
              ) : null}
            </li>
          )
        }

        const count = commentCounts.get(node.path) ?? 0
        const isActive = node.path === activePath
        const isOverflowHover = overflowHoverPath === node.path
        return (
          <li key={`file:${node.path}`} role="treeitem">
            <button
              type="button"
              className={`file-tree-file${isActive ? ' active' : ''}${isOverflowHover ? ' is-overflow-hover' : ''}`}
              style={rowStyle}
              onClick={() => onSelectFile(node.path)}
              onMouseEnter={(e) => onNameHover(e, node.path, node.name, 'file')}
              onMouseLeave={onNameLeave}
              onFocus={(e) => onNameHover(e, node.path, node.name, 'file')}
              onBlur={onNameLeave}
            >
              {depth > 0 ? (
                <span
                  className="file-tree-branch"
                  style={{ left: `${0.45 + (depth - 1) * 0.7 + 0.28}rem` }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="file-tree-chevron file-tree-chevron-spacer" aria-hidden="true" />
              <span className={`status status-${node.file.status}`}>
                <StatusIcon status={node.file.status} />
              </span>
              <FileIcon className="file-tree-icon" />
              <span className="file-tree-name">{node.name}</span>
              {count > 0 ? <span className="badge">{count}</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function FileDiffSection({
  file,
  lineComments,
  fileComments,
  draftLine,
  draftFilePath,
  body,
  busy,
  setBody,
  onStartLineComment,
  onStartFileComment,
  onSubmitLine,
  onSubmitFile,
  onClearDrafts,
  onEdit,
  onResolve,
  onDispatch,
  onDelete,
  reviewed,
  onToggleReviewed,
  showWhitespace,
  onToggleShowWhitespace,
  fileCommentIds,
  focusCommentId,
  canPrevComment,
  canNextComment,
  onPrevComment,
  onNextComment,
  onFirstComment,
}: {
  file: DiffFile
  lineComments: LineComment[]
  fileComments: FileComment[]
  draftLine: {
    path: string
    /** First line of the selection (inclusive). */
    startLine: number
    /** Last line of the selection (inclusive). */
    line: number
    /** Display index of the last selected row (compose box anchors here). */
    anchorIdx: number
    lineType: LineType
    snippet: string
  } | null
  draftFilePath: string | null
  body: string
  busy: boolean
  setBody: (value: string) => void
  onStartLineComment: (args: {
    path: string
    startLine: number
    line: number
    anchorIdx: number
    lineType: LineType
    snippet: string
  }) => void
  onStartFileComment: (path: string) => void
  onSubmitLine: () => void
  onSubmitFile: () => void
  onClearDrafts: () => void
  onEdit: (id: string, body: string) => Promise<void>
  onResolve: (id: string, resolved: boolean) => Promise<void>
  onDispatch: (id: string, dispatched: boolean) => Promise<void>
  reviewed: boolean
  onToggleReviewed: (path: string, reviewed: boolean) => void
  onDelete: (id: string) => Promise<void>
  showWhitespace: boolean
  onToggleShowWhitespace: () => void
  fileCommentIds: string[]
  focusCommentId: string | null
  canPrevComment: boolean
  canNextComment: boolean
  onPrevComment: () => void
  onNextComment: () => void
  onFirstComment: () => void
}) {
  const displayFile = useMemo(() => {
    if (showWhitespace) return file
    return { ...file, lines: hideWhitespaceOnlyChanges(file.lines) }
  }, [file, showWhitespace])
  const highlighted: LineTokens[] | null = useHighlightedDiff(displayFile)
  const [expanded, setExpanded] = useState(!reviewed)
  const wasReviewed = useRef(reviewed)

  useEffect(() => {
    if (reviewed !== wasReviewed.current) {
      wasReviewed.current = reviewed
      setExpanded(!reviewed)
    }
  }, [reviewed])
  const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null)

  useEffect(() => {
    if (!focusCommentId || !fileCommentIds.includes(focusCommentId)) return
    setExpanded(true)
    scrollToCommentElement(focusCommentId)
  }, [focusCommentId, fileCommentIds])

  const [lineSelect, setLineSelect] = useState<{
    path: string
    anchorIdx: number
    endIdx: number
    lineType: LineType
  } | null>(null)
  const lineSelectRef = useRef<typeof lineSelect>(null)
  const displayLinesRef = useRef(displayFile.lines)
  displayLinesRef.current = displayFile.lines
  const onStartLineCommentRef = useRef(onStartLineComment)
  onStartLineCommentRef.current = onStartLineComment

  function commitLineSelect() {
    const current = lineSelectRef.current
    if (!current) return
    const lines = displayLinesRef.current
    const lo = Math.min(current.anchorIdx, current.endIdx)
    const hi = Math.max(current.anchorIdx, current.endIdx)
    const startLine = lines[lo]
    const endLineRow = lines[hi]
    if (
      !startLine ||
      !endLineRow ||
      !isCommentableLine(startLine) ||
      !isCommentableLine(endLineRow)
    ) {
      lineSelectRef.current = null
      setLineSelect(null)
      return
    }
    const startNo = lineNumberFor(startLine)
    const endNo = lineNumberFor(endLineRow)
    if (startNo === null || endNo === null) {
      lineSelectRef.current = null
      setLineSelect(null)
      return
    }
    onStartLineCommentRef.current({
      path: current.path,
      startLine: Math.min(startNo, endNo),
      line: Math.max(startNo, endNo),
      anchorIdx: hi,
      lineType: current.lineType,
      snippet: rangeSnippet(lines, lo, hi),
    })
    lineSelectRef.current = null
    setLineSelect(null)
  }

  function extendLineSelect(targetIdx: number) {
    const prev = lineSelectRef.current
    if (!prev || prev.path !== file.path) return
    const endIdx = contiguousRangeEnd(
      displayLinesRef.current,
      prev.anchorIdx,
      targetIdx,
      prev.lineType,
    )
    if (endIdx === prev.endIdx) return
    const next = { ...prev, endIdx }
    lineSelectRef.current = next
    setLineSelect(next)
  }

  function beginLineSelect(
    idx: number,
    lineType: LineType,
    pointerId: number,
    target: HTMLElement,
  ) {
    const initial = {
      path: file.path,
      anchorIdx: idx,
      endIdx: idx,
      lineType,
    }
    lineSelectRef.current = initial
    setLineSelect(initial)
    onClearDrafts()

    function onPointerMove(e: PointerEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const lineEl = el?.closest?.('[data-line-idx]') as HTMLElement | null
      if (!lineEl) return
      const block = lineEl.closest('.diff-file') as HTMLElement | null
      if (!block || block.getAttribute('data-file-path') !== file.path) return
      const nextIdx = Number(lineEl.dataset.lineIdx)
      if (!Number.isFinite(nextIdx)) return
      extendLineSelect(nextIdx)
    }

    function cleanup() {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      try {
        target.releasePointerCapture(pointerId)
      } catch {
        // already released
      }
    }

    function onPointerUp() {
      cleanup()
      commitLineSelect()
    }

    function onPointerCancel() {
      cleanup()
      lineSelectRef.current = null
      setLineSelect(null)
    }

    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      cleanup()
      lineSelectRef.current = null
      setLineSelect(null)
    }

    try {
      target.setPointerCapture(pointerId)
    } catch {
      // capture optional; window listeners still work
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
  }

  const selectLo =
    lineSelect && lineSelect.path === file.path
      ? Math.min(lineSelect.anchorIdx, lineSelect.endIdx)
      : null
  const selectHi =
    lineSelect && lineSelect.path === file.path
      ? Math.max(lineSelect.anchorIdx, lineSelect.endIdx)
      : null
  const multiLineDraft =
    draftLine !== null && draftLine.path === file.path && draftLine.startLine !== draftLine.line
  const hoveredComment =
    hoveredCommentId === null
      ? null
      : (lineComments.find((c) => c.id === hoveredCommentId) ?? null)
  const hoveredDisplayRange = hoveredComment
    ? commentDisplayRange(hoveredComment, file.path, displayFile.lines)
    : null

  return (
    <section
      id={fileAnchorId(file.path)}
      className={`diff-file${expanded ? '' : ' is-collapsed'}`}
      data-file-path={file.path}
    >
      <div className="diff-file-header">
        <div className="diff-file-title">
          <button
            type="button"
            className="diff-file-toggle"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse file' : 'Expand file'}
            title={expanded ? 'Collapse file' : 'Expand file'}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <svg
              className={`diff-file-toggle-icon${expanded ? '' : ' is-collapsed'}`}
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="M6.5 3.25 11 8l-4.5 4.75"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className={`status status-${file.status}`}>
            <StatusIcon status={file.status} />
          </span>
          <FileIcon className="diff-file-icon" />
          <strong className="diff-file-path" title={file.path}>
            {/* LRM keeps LTR punctuation (e.g. .tsx) attached under rtl ellipsis. */}
            {file.path}
            {'\u200E'}
          </strong>
        </div>
        <div className="diff-file-actions">
          <DiffStat {...countFileDiffStats(displayFile)} />
          <div className="file-comment-nav">
            <button
              type="button"
              className="file-comment-nav-caret"
              title="Previous comment"
              aria-label="Previous comment"
              disabled={!canPrevComment}
              onClick={onPrevComment}
            >
              <CaretLeftIcon />
            </button>
            <button
              type="button"
              className="file-comment-nav-count"
              title={
                fileCommentIds.length > 0
                  ? `Go to first of ${fileCommentIds.length} comment${
                      fileCommentIds.length === 1 ? '' : 's'
                    }`
                  : 'No comments in this file'
              }
              aria-label={
                fileCommentIds.length > 0
                  ? `Go to first of ${fileCommentIds.length} comment${
                      fileCommentIds.length === 1 ? '' : 's'
                    }`
                  : 'No comments in this file'
              }
              onClick={onFirstComment}
            >
              <CommentBubbleIcon />
              <span>{fileCommentIds.length}</span>
            </button>
            <button
              type="button"
              className="file-comment-nav-caret"
              title="Next comment"
              aria-label="Next comment"
              disabled={!canNextComment}
              onClick={onNextComment}
            >
              <CaretRightIcon />
            </button>
          </div>
          <button
            type="button"
            className="comment-bubble"
            title="Comment on this file"
            aria-label="Comment on this file"
            onClick={() => onStartFileComment(file.path)}
          >
            <CommentBubbleIcon />
            Comment
          </button>
          <button
            type="button"
            className={`reviewed-toggle${reviewed ? ' is-reviewed' : ''}`}
            title={
              reviewed
                ? 'Mark this file as not reviewed'
                : 'Mark this file reviewed, collapse it and move to the next'
            }
            aria-label={
              reviewed ? 'Mark this file as not reviewed' : 'Mark this file reviewed'
            }
            aria-pressed={reviewed}
            disabled={busy}
            onClick={() => onToggleReviewed(file.path, !reviewed)}
          >
            <CheckboxIcon checked={reviewed} />
            Reviewed
          </button>
          <button
            type="button"
            className={`reviewed-toggle${showWhitespace ? ' is-reviewed' : ''}`}
            title={
              showWhitespace
                ? 'Hide whitespace-only changes'
                : 'Show whitespace-only changes'
            }
            aria-label={
              showWhitespace
                ? 'Hide whitespace-only changes'
                : 'Show whitespace-only changes'
            }
            aria-pressed={showWhitespace}
            onClick={onToggleShowWhitespace}
          >
            <CheckboxIcon checked={showWhitespace} />
            Whitespace
          </button>
        </div>
      </div>
      {expanded ? (
        <>
          {fileComments.map((c) => (
            <EditableComment
              key={c.id}
              comment={c}
              busy={busy}
              onSave={onEdit}
              onResolve={onResolve}
              onDispatch={onDispatch}
              onDelete={onDelete}
              className="file-level"
            />
          ))}
          {draftFilePath === file.path ? (
            <div className="comment-compose file-level">
              <div className="compose-panel">
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Comment on this file"
                  rows={3}
                  autoFocus
                  onKeyDown={(e) => {
                    if (!isSaveShortcut(e)) return
                    e.preventDefault()
                    if (!busy) onSubmitFile()
                  }}
                />
                <DraftActions
                  busy={busy}
                  saveDisabled={!body.trim()}
                  onSave={onSubmitFile}
                  onCancel={onClearDrafts}
                />
              </div>
            </div>
          ) : null}
          <div className={`unified-diff${lineSelect ? ' is-selecting-lines' : ''}`}>
            <div className="unified-diff-content">
              {displayFile.lines.map((line, idx) => {
                if (line.type === 'meta') {
                  return (
                    <div key={idx} className="diff-line meta">
                      <span className="gutter gutter-old" />
                      <span className="gutter gutter-new" />
                      <pre className="line-code">{line.content}</pre>
                    </div>
                  )
                }

                const lineNo = lineNumberFor(line)
                const related = lineComments.filter((c) =>
                  isCommentAnchorRow(c, file.path, displayFile.lines, idx),
                )
                const canComment = lineNo !== null
                const inDragSelect =
                  selectLo !== null && selectHi !== null && idx >= selectLo && idx <= selectHi
                const inDraftRange =
                  draftLine !== null &&
                  draftLine.path === file.path &&
                  draftLine.lineType === line.type &&
                  lineNo !== null &&
                  lineNo >= draftLine.startLine &&
                  lineNo <= draftLine.line
                const inHoverRange =
                  hoveredDisplayRange !== null &&
                  idx >= hoveredDisplayRange.lo &&
                  idx <= hoveredDisplayRange.hi
                const rangeHighlight = inDragSelect || inDraftRange
                const showDraftCompose =
                  draftLine !== null &&
                  draftLine.path === file.path &&
                  idx === draftLine.anchorIdx

                return (
                  <div key={idx} className="diff-line-block">
                    <div
                      className={`diff-line ${line.type}${rangeHighlight ? ' is-line-range' : ''}${
                        inDragSelect || inDraftRange ? ' is-line-selecting' : ''
                      }${inHoverRange ? ' is-line-hover' : ''}`}
                    >
                      <span className="gutter gutter-old">{line.oldLine ?? ''}</span>
                      <span className="gutter gutter-new">{line.newLine ?? ''}</span>
                      <button
                        type="button"
                        className="line-body"
                        disabled={!canComment}
                        data-line-idx={idx}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          if (lineNo === null || !isCommentableLine(line)) return
                          e.preventDefault()
                          beginLineSelect(idx, line.type, e.pointerId, e.currentTarget)
                        }}
                      >
                        <LineCode content={line.content} tokens={highlighted?.[idx]} />
                      </button>
                    </div>
                    {related.map((c) => (
                      <EditableComment
                        key={c.id}
                        comment={c}
                        busy={busy}
                        onSave={onEdit}
                        onResolve={onResolve}
                        onDispatch={onDispatch}
                        onDelete={onDelete}
                        onHoverChange={setHoveredCommentId}
                        className="inline"
                      />
                    ))}
                    {showDraftCompose ? (
                      <div className="comment-compose inline">
                        <div className="compose-panel">
                          <textarea
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            placeholder={
                              multiLineDraft
                                ? `Comment on lines ${draftLine.startLine}–${draftLine.line}`
                                : 'Comment on this line'
                            }
                            rows={3}
                            autoFocus
                            onKeyDown={(e) => {
                              if (!isSaveShortcut(e)) return
                              e.preventDefault()
                              if (!busy) onSubmitLine()
                            }}
                          />
                          <DraftActions
                            busy={busy}
                            saveDisabled={!body.trim()}
                            onSave={onSubmitLine}
                            onCancel={onClearDrafts}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}

const SCROLL_SPY_OFFSET = 96
const FILE_LIST_WIDTH_MAX = 480

/** Intrinsic width needed to show every visible name (and badge) without clipping. */
function measureFileListContentWidth(list: HTMLElement): number {
  const listLeft = list.getBoundingClientRect().left
  const listStyle = getComputedStyle(list)
  const padRight = Number.parseFloat(listStyle.paddingRight) || 0
  const borderRight = Number.parseFloat(listStyle.borderRightWidth) || 0
  // border-box width must cover content end + list padding-right + border-right.
  const trailing = padRight + borderRight
  let needed = 0

  const heading = list.querySelector('h3') as HTMLElement | null
  if (heading) {
    needed = Math.max(
      needed,
      heading.getBoundingClientRect().left + heading.scrollWidth - listLeft + trailing,
    )
  }

  for (const name of list.querySelectorAll('.file-tree-name')) {
    const el = name as HTMLElement
    const row = el.closest('.file-tree-file, .file-tree-dir') as HTMLElement | null
    if (!row) continue

    const rowStyle = getComputedStyle(row)
    const rowPadRight = Number.parseFloat(rowStyle.paddingRight) || 0
    const gap = Number.parseFloat(rowStyle.columnGap || rowStyle.gap) || 0
    const badge = row.querySelector('.badge') as HTMLElement | null

    // scrollWidth equals the flex slot when text is not clipped; use a Range for
    // the real glyph width so short labels do not inflate, and long ones stay exact.
    let nameWidth = el.scrollWidth
    if (el.scrollWidth <= el.clientWidth + 1) {
      const range = document.createRange()
      range.selectNodeContents(el)
      nameWidth = range.getBoundingClientRect().width
    }

    let contentEnd = el.getBoundingClientRect().left + nameWidth
    if (badge) {
      contentEnd += gap + badge.getBoundingClientRect().width
    }
    contentEnd += rowPadRight

    needed = Math.max(needed, contentEnd - listLeft + trailing)
  }

  // Subpixel AA / rounding can still clip by a hair without a small buffer.
  return Math.min(FILE_LIST_WIDTH_MAX, Math.ceil(needed + 1))
}

export function CommitReview({
  target,
  files,
  comments: allComments,
  messageEdit,
  reviewed,
  reviewedPaths,
  onReviewFileChange,
  initialFilePath,
  onFilePathChange,
  nav,
}: Props) {
  const commit = target.kind === 'commit' ? target.commit : null
  const reviewSha = target.kind === 'branch' ? target.headSha : target.commit.sha
  const diffBaseSha = target.kind === 'branch' ? target.baseSha : undefined
  const comments = useMemo(
    () => allComments.filter((comment) => comment.diffBaseSha === diffBaseSha),
    [allComments, diffBaseSha],
  )
  const earlierComments = target.kind === 'branch'
    ? allComments.filter((comment) =>
        comment.diffBaseSha !== undefined &&
        (comment.commitSha !== reviewSha || comment.diffBaseSha !== diffBaseSha),
      )
    : []
  const commentLabel = target.kind === 'branch'
    ? 'Comment on this branch'
    : 'Comment on this commit'
  const [activePath, setActivePath] = useState(() => {
    if (initialFilePath && files.some((f) => f.path === initialFilePath)) {
      return initialFilePath
    }
    return files[0]?.path ?? ''
  })
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [draftLine, setDraftLine] = useState<{
    path: string
    startLine: number
    line: number
    anchorIdx: number
    lineType: LineType
    snippet: string
  } | null>(null)
  const [draftCommit, setDraftCommit] = useState(false)
  const [draftFilePath, setDraftFilePath] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollingToRef = useRef<string | null>(null)
  const commitReviewRef = useRef<HTMLDivElement>(null)
  const commitPanelRef = useRef<HTMLElement>(null)
  const commitStuckSentinelRef = useRef<HTMLDivElement>(null)
  const [commitStuck, setCommitStuck] = useState(false)
  const [nameHover, setNameHover] = useState<NameHover | null>(null)
  const fileListRef = useRef<HTMLElement | null>(null)
  const fileListWidthFloorRef = useRef(0)
  const fileListWidthShaRef = useRef(reviewSha)
  const [fileListWidth, setFileListWidth] = useState(0)
  const [fileListCollapsed, setFileListCollapsed] = useState(readFileListCollapsed)
  const [fileListScrollHidden, setFileListScrollHidden] = useState(false)
  const [showWhitespace, setShowWhitespace] = useState(readStoredShowWhitespace)
  const fileListCollapsedRef = useRef(fileListCollapsed)
  fileListCollapsedRef.current = fileListCollapsed


  function toggleShowWhitespace() {
    setShowWhitespace((prev) => {
      const next = !prev
      writeStoredShowWhitespace(next)
      return next
    })
  }

  function toggleFileListCollapsed() {
    setFileListCollapsed((prev) => {
      if (prev) setFileListScrollHidden(false)
      const next = !prev
      writeFileListCollapsed(next)
      return next
    })
  }

  function onFileListChipClick() {
    // Pane is faded: first click restores it (chip looks collapsed while faded).
    if (!fileListCollapsed && fileListScrollHidden) {
      setFileListScrollHidden(false)
      return
    }
    toggleFileListCollapsed()
  }

  const chipCaretCollapsed = fileListCollapsed || fileListScrollHidden

  const fileTree = useMemo(() => buildFileTree(files), [files])

  function handleNameHover(
    event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>,
    path: string,
    text: string,
    kind: 'file' | 'dir',
  ) {
    const row = event.currentTarget
    const nameEl = row.querySelector('.file-tree-name') as HTMLElement | null
    if (!nameEl) {
      setNameHover(null)
      return
    }
    if (nameEl.scrollWidth <= nameEl.clientWidth + 1) {
      setNameHover(null)
      return
    }
    const rowRect = row.getBoundingClientRect()
    const nameRect = nameEl.getBoundingClientRect()
    const rightPad = 8
    const tree = row.closest('.file-tree')
    const rails: { left: number }[] = []
    if (tree) {
      for (const rail of tree.querySelectorAll('.file-tree-rail')) {
        const railRect = (rail as HTMLElement).getBoundingClientRect()
        if (railRect.bottom <= rowRect.top || railRect.top >= rowRect.bottom) continue
        rails.push({ left: railRect.left - rowRect.left })
      }
    }
    setNameHover({
      text,
      path,
      kind,
      rowTop: rowRect.top,
      rowLeft: rowRect.left,
      rowHeight: rowRect.height,
      rowWidth: nameRect.left - rowRect.left + nameEl.scrollWidth + rightPad,
      textLeft: nameRect.left - rowRect.left,
      textTop: nameRect.top - rowRect.top,
      textHeight: nameRect.height,
      rails,
    })
  }

  function handleNameLeave() {
    setNameHover(null)
  }

  const commentCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of comments) {
      if (c.commitSha !== reviewSha) continue
      if (isCommentResolved(c)) continue
      if (c.kind === 'line' || c.kind === 'file') {
        map.set(c.path, (map.get(c.path) ?? 0) + 1)
      }
    }
    return map
  }, [comments, reviewSha])

  const commentsByFile = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const file of files) {
      const fileCs = comments.filter(
        (c): c is FileComment =>
          c.kind === 'file' && c.commitSha === reviewSha && c.path === file.path,
      )
      const lineCs = comments.filter(
        (c): c is LineComment =>
          c.kind === 'line' && c.commitSha === reviewSha && c.path === file.path,
      )
      map.set(
        file.path,
        orderedOpenCommentIdsForFile(file, fileCs, lineCs, showWhitespace),
      )
    }
    return map
  }, [files, comments, reviewSha, showWhitespace])

  const orderedReviewComments = useMemo(() => {
    const list: { id: string; path: string }[] = []
    for (const file of files) {
      for (const id of commentsByFile.get(file.path) ?? []) {
        list.push({ id, path: file.path })
      }
    }
    return list
  }, [files, commentsByFile])

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)

  useEffect(() => {
    if (
      activeCommentId &&
      !orderedReviewComments.some((c) => c.id === activeCommentId)
    ) {
      setActiveCommentId(null)
    }
  }, [activeCommentId, orderedReviewComments])

  useLayoutEffect(() => {
    const panel = commitPanelRef.current
    const root = commitReviewRef.current
    if (!panel || !root) return

    const sync = () => {
      root.style.setProperty(
        '--commit-header-sticky-height',
        `${panel.offsetHeight}px`,
      )
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [reviewSha])

  // Re-measure after stuck styles (meta hide) apply, same frame as paint.
  useLayoutEffect(() => {
    const panel = commitPanelRef.current
    const root = commitReviewRef.current
    if (!panel || !root) return
    root.style.setProperty(
      '--commit-header-sticky-height',
      `${panel.offsetHeight}px`,
    )
  }, [commitStuck])

  useEffect(() => {
    const sentinel = commitStuckSentinelRef.current
    if (!sentinel) return
    const io = new IntersectionObserver(
      ([entry]) => {
        setCommitStuck(!(entry?.isIntersecting ?? true))
      },
      { threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [reviewSha])

  function focusComment(id: string) {
    setActiveCommentId(id)
  }

  function commentNavState(filePath: string) {
    const fileIds = commentsByFile.get(filePath) ?? []
    const total = orderedReviewComments
    const activeIndex = activeCommentId
      ? total.findIndex((c) => c.id === activeCommentId)
      : -1

    // Prev/next walk every open comment in the commit, from any file header.
    const canPrev = total.length > 0 && (activeIndex === -1 || activeIndex > 0)
    const canNext =
      total.length > 0 && (activeIndex === -1 || activeIndex < total.length - 1)

    function goPrev() {
      if (total.length === 0) return
      if (activeIndex === -1) {
        focusComment(total[total.length - 1]!.id)
        return
      }
      if (activeIndex > 0) focusComment(total[activeIndex - 1]!.id)
    }

    function goNext() {
      if (total.length === 0) return
      if (activeIndex === -1) {
        focusComment(total[0]!.id)
        return
      }
      if (activeIndex < total.length - 1) {
        focusComment(total[activeIndex + 1]!.id)
      }
    }

    function goFirst() {
      if (fileIds[0]) focusComment(fileIds[0])
    }

    return { canPrev, canNext, goPrev, goNext, goFirst }
  }

  function clearDrafts() {
    setDraftLine(null)
    setDraftCommit(false)
    setDraftFilePath(null)
    setBody('')
  }

  function selectFile(path: string) {
    clearDrafts()
    scrollingToRef.current = path
    setActivePath(path)
    const el = document.getElementById(fileAnchorId(path))
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => {
      if (scrollingToRef.current === path) scrollingToRef.current = null
    }, 700)
  }

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  useEffect(() => {
    const preferred =
      initialFilePath && files.some((f) => f.path === initialFilePath)
        ? initialFilePath
        : (files[0]?.path ?? '')
    setActivePath(preferred)
    clearDrafts()
    setExpandedDirs(new Set(collectDirPaths(fileTree)))
    setNameHover(null)
    setFileListScrollHidden(window.scrollY > 8)
  }, [reviewSha, files, fileTree, initialFilePath])

  // Grow the floating file list to fit visible labels; never shrink on collapse.
  useLayoutEffect(() => {
    if (fileListCollapsed) return
    const list = fileListRef.current
    if (!list) return

    if (fileListWidthShaRef.current !== reviewSha) {
      fileListWidthShaRef.current = reviewSha
      fileListWidthFloorRef.current = 0
    }

    const needed = measureFileListContentWidth(list)
    const next = Math.max(fileListWidthFloorRef.current, needed)
    fileListWidthFloorRef.current = next
    setFileListWidth((prev) => (prev === next ? prev : next))
  }, [reviewSha, expandedDirs, files, commentCounts, fileTree, fileListCollapsed])

  useEffect(() => {
    let lastY = window.scrollY
    let traveled = 0
    let settleTimer = 0

    const atTop = () => window.scrollY <= 8

    const onScroll = () => {
      if (fileListCollapsedRef.current) return

      const y = window.scrollY
      traveled += Math.abs(y - lastY)
      lastY = y

      if (atTop() || fileListRef.current?.matches(':hover')) {
        traveled = 0
        setFileListScrollHidden(false)
      } else if (traveled > 24) {
        // Show while the user is actively scrolling.
        setFileListScrollHidden(false)
      }

      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => {
        traveled = 0
        if (fileListCollapsedRef.current) return
        // Hide when idle away from the top (unless the pane is hovered).
        if (!atTop() && !fileListRef.current?.matches(':hover')) {
          setFileListScrollHidden(true)
        }
      }, 450)
    }

    // Start hidden unless we are already at the top.
    setFileListScrollHidden(!atTop())

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.clearTimeout(settleTimer)
    }
  }, [])

  useEffect(() => {
    onFilePathChange?.(activePath || null)
  }, [activePath, onFilePathChange])

  useEffect(() => {
    if (!nameHover) return
    const clear = () => setNameHover(null)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('resize', clear)
    return () => {
      window.removeEventListener('scroll', clear, true)
      window.removeEventListener('resize', clear)
    }
  }, [nameHover])

  useEffect(() => {
    if (files.length === 0) return

    const updateActiveFromScroll = () => {
      if (scrollingToRef.current) return
      let current = files[0]!.path
      for (const file of files) {
        const el = document.getElementById(fileAnchorId(file.path))
        if (!el) continue
        if (el.getBoundingClientRect().top <= SCROLL_SPY_OFFSET) {
          current = file.path
        }
      }
      setActivePath((prev) => (prev === current ? prev : current))
    }

    updateActiveFromScroll()
    window.addEventListener('scroll', updateActiveFromScroll, { passive: true })
    window.addEventListener('resize', updateActiveFromScroll)
    return () => {
      window.removeEventListener('scroll', updateActiveFromScroll)
      window.removeEventListener('resize', updateActiveFromScroll)
    }
  }, [files, reviewSha])

  const sendableHere = sendableOnCommit(comments, reviewSha)
  const commitComments = comments.filter(
    (c) => c.kind === 'commit' && c.commitSha === reviewSha,
  )
  const lineComments = comments.filter(
    (c): c is LineComment => c.kind === 'line' && c.commitSha === reviewSha,
  )

  async function submitLine() {
    if (!draftLine || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {
        kind: 'line',
        commitSha: reviewSha,
        diffBaseSha,
        path: draftLine.path,
        line: draftLine.line,
        lineType: draftLine.lineType,
        body: body.trim(),
      }
      if (draftLine.startLine !== draftLine.line) {
        payload.startLine = draftLine.startLine
      } else if (draftLine.snippet.includes('\n')) {
        // Multi-line snippet must always carry an explicit range start.
        const extra = draftLine.snippet.split('\n').length - 1
        payload.startLine = Math.max(1, draftLine.line - extra)
      }
      if (draftLine.snippet.trim() !== '') {
        payload.snippet = draftLine.snippet
      }
      const file = await createComment(payload)
      onReviewFileChange(file)
      clearDrafts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save comment')
    } finally {
      setBusy(false)
    }
  }

  async function submitCommit() {
    if (!body.trim()) return
    setBusy(true)
    setError(null)
    try {
      const file = await createComment({
        kind: 'commit',
        commitSha: reviewSha,
        diffBaseSha,
        body: body.trim(),
      })
      onReviewFileChange(file)
      clearDrafts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save comment')
    } finally {
      setBusy(false)
    }
  }

  async function submitFile() {
    if (!draftFilePath || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      const file = await createComment({
        kind: 'file',
        commitSha: reviewSha,
        diffBaseSha,
        path: draftFilePath,
        body: body.trim(),
      })
      onReviewFileChange(file)
      clearDrafts()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save comment')
    } finally {
      setBusy(false)
    }
  }

  async function onEdit(id: string, nextBody: string) {
    setBusy(true)
    setError(null)
    try {
      const file = await updateComment(id, { body: nextBody })
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update comment')
    } finally {
      setBusy(false)
    }
  }

  async function onResolve(id: string, resolved: boolean) {
    setBusy(true)
    setError(null)
    try {
      const file = await setCommentResolved(id, resolved)
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update comment')
    } finally {
      setBusy(false)
    }
  }

  async function onDispatch(id: string, dispatched: boolean) {
    setBusy(true)
    setError(null)
    try {
      const file = await setCommentDispatched(id, dispatched)
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update comment')
    } finally {
      setBusy(false)
    }
  }

  const reviewedFiles = useMemo(
    () => new Set(reviewedPaths[reviewSha] ?? []),
    [reviewedPaths, reviewSha],
  )

  async function onToggleFileReviewed(path: string, nextReviewed: boolean) {
    setBusy(true)
    setError(null)
    try {
      const updated = await setReviewedFile(reviewSha, path, nextReviewed)
      onReviewFileChange(updated)
      if (nextReviewed) scrollToNextFile(path, updated.reviewedPaths?.[reviewSha] ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mark the file reviewed')
    } finally {
      setBusy(false)
    }
  }

  /** Jump to the next file still to read, falling back to the next one along. */
  function scrollToNextFile(fromPath: string, reviewedNow: string[]): void {
    const done = new Set(reviewedNow)
    const index = files.findIndex((f) => f.path === fromPath)
    if (index === -1) return
    const after = files.slice(index + 1)
    const target = after.find((f) => !done.has(f.path)) ?? after[0]
    if (!target) return
    setActivePath(target.path)
    // Let the collapse land before measuring where to scroll to.
    requestAnimationFrame(() => {
      document
        .getElementById(fileAnchorId(target.path))
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  async function onDispatchMany(ids: string[]) {
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const file = await setCommentsDispatched(ids, true)
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send comments to the agent')
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(id: string) {
    setBusy(true)
    setError(null)
    try {
      const file = await removeComment(id)
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete comment')
    } finally {
      setBusy(false)
    }
  }

  async function saveMessageField(field: 'subject' | 'body', value: string) {
    setBusy(true)
    setError(null)
    try {
      const file = await upsertMessageEdit(reviewSha, { [field]: value })
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save message edit')
    } finally {
      setBusy(false)
    }
  }

  async function resetMessageField(field: 'subject' | 'body') {
    setBusy(true)
    setError(null)
    try {
      const file = await upsertMessageEdit(reviewSha, { [field]: null })
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset message edit')
    } finally {
      setBusy(false)
    }
  }

  async function toggleReviewed() {
    setBusy(true)
    setError(null)
    try {
      const file = await setReviewed(reviewSha, !reviewed)
      onReviewFileChange(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update reviewed state')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="commit-review" ref={commitReviewRef}>
      <div
        ref={commitStuckSentinelRef}
        className="commit-sticky-sentinel"
        aria-hidden="true"
      />
      <section
        className={`commit-message-panel${commitStuck ? ' is-stuck' : ''}`}
        ref={commitPanelRef}
      >
        <div className="commit-message-header">
          <div className="commit-title-block">
            {target.kind === 'branch' ? (
              <>
                <h2>All changes</h2>
                <p className="meta commit-title-meta">{target.reviewBranch} vs. {target.baseBranch}</p>
              </>
            ) : commit ? (
              <>
                <EditableCommitText
                  kind="subject"
                  original={commit.subject}
                  edited={messageEdit?.subject}
                  busy={busy}
                  onSave={(value) => saveMessageField('subject', value)}
                  onReset={() => resetMessageField('subject')}
                />
                <p className="meta commit-title-meta">
                  <span className="sha-with-icon">
                    <CommitIcon className="commit-hash-icon" />
                    <code className="sha">{commit.shortSha}</code>
                  </span>
                  <span className="sep">·</span>
                  {commit.authorName}
                  <span className="sep">·</span>
                  {formatCommitTime(commit.authoredAt)}
                </p>
              </>
            ) : null}
          </div>
          <div className="commit-nav-group">
            <DiffStat {...sumDiffStats(files)} />
            <button
              type="button"
              className="comment-bubble"
              title={commentLabel}
              aria-label={commentLabel}
              onClick={() => {
                setDraftCommit(true)
                setDraftLine(null)
                setDraftFilePath(null)
                setBody('')
              }}
            >
              <CommentBubbleIcon />
              Comment
            </button>
            {commit ? (
              <button
                type="button"
                className={`reviewed-toggle${reviewed ? ' is-reviewed' : ''}`}
                title={reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
                aria-label={reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
                aria-pressed={reviewed}
                disabled={busy}
                onClick={() => void toggleReviewed()}
              >
                <CheckboxIcon checked={reviewed} />
                Reviewed
              </button>
            ) : null}
            {sendableHere.length > 0 ? (
              <button
                type="button"
                className="reviewed-toggle dispatch-bulk"
                title={`Send ${sendableHere.length} comment${sendableHere.length === 1 ? '' : 's'} on this ${target.kind} to the agent`}
                aria-label={`Send ${sendableHere.length} comment${sendableHere.length === 1 ? '' : 's'} on this ${target.kind} to the agent`}
                disabled={busy}
                onClick={() => void onDispatchMany(sendableHere.map((c) => c.id))}
              >
                <AgentIcon />
                Send {sendableHere.length}
              </button>
            ) : null}
            {commit ? (
              <div className="commit-nav">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!(nav.canPrev ?? nav.index > 0)}
                  onClick={nav.onPrev}
                >
                  Previous
                </button>
                <span className="commit-nav-index">
                  {nav.index + 1} / {nav.total}
                </span>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!(nav.canNext ?? (nav.index >= 0 && nav.index < nav.total - 1))}
                  onClick={nav.onNext}
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="commit-message-content">
          {commit ? (
            <div className="commit-message-prose">
              <EditableCommitText
                kind="body"
                original={commit.body}
                edited={messageEdit?.body}
                busy={busy}
                onSave={(value) => saveMessageField('body', value)}
                onReset={() => resetMessageField('body')}
              />
            </div>
          ) : null}
          {earlierComments.length > 0 ? (
            <details className="commit-message-comments">
              <summary>Comments on earlier versions ({earlierComments.length})</summary>
              {earlierComments.map((comment) => (
                <div key={comment.id}>
                  <p className="meta">
                    {comment.commitSha.slice(0, 7)}
                    {comment.kind !== 'commit' ? ` · ${comment.path}` : ''}
                    {comment.kind === 'line' ? `:${comment.line}` : ''}
                  </p>
                  {comment.kind === 'line' && comment.snippet ? <pre>{comment.snippet}</pre> : null}
                  <EditableComment
                    comment={comment}
                    busy={busy}
                    onSave={onEdit}
                    onResolve={onResolve}
                    onDispatch={onDispatch}
                    onDelete={onDelete}
                  />
                </div>
              ))}
            </details>
          ) : null}
          {commitComments.length > 0 || draftCommit ? (
            <div className="commit-message-comments">
              {commitComments.map((c) => (
                <EditableComment
                  key={c.id}
                  comment={c}
                  busy={busy}
                  onSave={onEdit}
                  onResolve={onResolve}
                  onDispatch={onDispatch}
                  onDelete={onDelete}
                />
              ))}
              {draftCommit ? (
                <div className="comment-compose commit-level">
                  <div className="compose-panel">
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder={commentLabel}
                      rows={3}
                      autoFocus
                      onKeyDown={(e) => {
                        if (!isSaveShortcut(e)) return
                        e.preventDefault()
                        if (!busy) void submitCommit()
                      }}
                    />
                    <DraftActions
                      busy={busy}
                      saveDisabled={!body.trim()}
                      onSave={() => void submitCommit()}
                      onCancel={clearDrafts}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <div
        className="diff-layout"
        style={
          {
            '--file-list-width': fileListWidth > 0 ? `${fileListWidth}px` : 'max-content',
          } as CSSProperties
        }
      >
        <div className="diff-files">
          {files.length === 0 ? (
            <p className="empty">No files changed.</p>
          ) : (
            files.map((file) => {
              const fileIds = commentsByFile.get(file.path) ?? []
              const nav = commentNavState(file.path)
              return (
              <FileDiffSection
                key={`${reviewSha}:${file.path}`}
                file={file}
                lineComments={lineComments.filter((c) => c.path === file.path)}
                fileComments={comments.filter(
                  (c): c is FileComment =>
                    c.kind === 'file' && c.commitSha === reviewSha && c.path === file.path,
                )}
                draftLine={draftLine}
                draftFilePath={draftFilePath}
                body={body}
                busy={busy}
                setBody={setBody}
                onStartLineComment={(args) => {
                  setDraftCommit(false)
                  setDraftFilePath(null)
                  setDraftLine(args)
                  setBody('')
                }}
                onStartFileComment={(path) => {
                  setDraftFilePath(path)
                  setDraftCommit(false)
                  setDraftLine(null)
                  setBody('')
                }}
                onSubmitLine={() => void submitLine()}
                onSubmitFile={() => void submitFile()}
                onClearDrafts={clearDrafts}
                onEdit={onEdit}
                onResolve={onResolve}
                onDispatch={onDispatch}
                reviewed={reviewedFiles.has(file.path)}
                onToggleReviewed={(path, next) => void onToggleFileReviewed(path, next)}
                onDelete={onDelete}
                showWhitespace={showWhitespace}
                onToggleShowWhitespace={toggleShowWhitespace}
                fileCommentIds={fileIds}
                focusCommentId={activeCommentId}
                canPrevComment={nav.canPrev}
                canNextComment={nav.canNext}
                onPrevComment={nav.goPrev}
                onNextComment={nav.goNext}
                onFirstComment={nav.goFirst}
              />
              )
            })
          )}
        </div>
        <button
          type="button"
          className="file-list-chip"
          aria-expanded={!fileListCollapsed && !fileListScrollHidden}
          aria-label={chipCaretCollapsed ? 'Expand file list' : 'Collapse file list'}
          title={chipCaretCollapsed ? 'Expand file list' : 'Collapse file list'}
          onClick={onFileListChipClick}
        >
          <div className="file-list-heading">
            <h3>
              {files.length} {files.length === 1 ? 'file' : 'files'}
            </h3>
            <span className="file-list-toggle" aria-hidden="true">
              <svg
                className={`file-list-toggle-icon${chipCaretCollapsed ? ' is-collapsed' : ''}`}
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M6.5 3.25 11 8l-4.5 4.75"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>
        </button>
        {!fileListCollapsed ? (
          <aside
            className={`file-list${fileListScrollHidden ? ' is-scroll-hidden' : ''}`}
            ref={fileListRef}
          >
            <div className="file-list-heading">
              <h3>
                {files.length} {files.length === 1 ? 'file' : 'files'}
              </h3>
            </div>
            {files.length === 0 ? (
              <p className="empty">No files changed.</p>
            ) : (
              <FileTree
                nodes={fileTree}
                depth={0}
                activePath={activePath || undefined}
                expanded={expandedDirs}
                commentCounts={commentCounts}
                overflowHoverPath={nameHover?.path ?? null}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
                onNameHover={handleNameHover}
                onNameLeave={handleNameLeave}
              />
            )}
          </aside>
        ) : null}
      </div>
      {nameHover ? (
        <div
          className={`file-tree-name-float${nameHover.kind === 'dir' ? ' is-dir' : ''}`}
          style={{
            top: nameHover.rowTop,
            left: nameHover.rowLeft,
            height: nameHover.rowHeight,
            width: nameHover.rowWidth,
          }}
          aria-hidden="true"
        >
          <span
            className="file-tree-name-float-bg"
            style={{ left: nameHover.textLeft }}
          />
          {nameHover.rails.map((rail, i) => (
            <span
              key={i}
              className="file-tree-name-float-rail"
              style={{ left: rail.left }}
            />
          ))}
          <span
            className="file-tree-name-float-label"
            style={{
              left: nameHover.textLeft,
              top: nameHover.textTop,
              height: nameHover.textHeight,
            }}
          >
            {nameHover.text}
          </span>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  )
}
