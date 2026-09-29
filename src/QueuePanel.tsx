import { useState } from 'react'
import type { QueueFile, QueueItem } from './types'
import { AgentIcon, TrashIcon } from './icons'

const PLACEHOLDER = `https://github.com/owner/repo/pull/12
https://github.com/owner/other-repo/pull/34`

function label(item: QueueItem): string {
  return `${item.repo} #${item.number}`
}

function QueueRow({
  item,
  isActive,
  busy,
  onOpen,
  onRemove,
}: {
  item: QueueItem
  isActive: boolean
  busy: boolean
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}) {
  const broken = item.error !== undefined
  const className = [
    'queue-row',
    isActive ? 'is-active' : '',
    item.status === 'done' ? 'is-done' : '',
    broken ? 'is-broken' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={className}>
      <button
        type="button"
        className="queue-row-open"
        disabled={busy || broken}
        title={broken ? item.error : `Open ${item.id}`}
        onClick={() => onOpen(item.id)}
      >
        <span className="queue-row-name">{label(item)}</span>
        {item.title === undefined ? null : (
          <span className="queue-row-title">{item.title}</span>
        )}
        {broken ? <span className="queue-row-error">{item.error}</span> : null}
      </button>
      <span className="queue-row-side">
        {item.addedBy === 'agent' ? (
          <span className="queue-row-agent" title="Added by an agent">
            <AgentIcon />
          </span>
        ) : null}
        <button
          type="button"
          className="comment-icon-btn"
          title={`Remove ${item.id} from the queue`}
          aria-label={`Remove ${item.id} from the queue`}
          disabled={busy}
          onClick={() => onRemove(item.id)}
        >
          <TrashIcon />
        </button>
      </span>
    </li>
  )
}

export function QueuePanel({
  queue,
  busy,
  onAdd,
  onOpen,
  onNext,
  onRemove,
  onClearFinished,
}: {
  queue: QueueFile
  busy: boolean
  onAdd: (text: string) => Promise<void>
  onOpen: (id: string) => Promise<void>
  onNext: () => Promise<void>
  onRemove: (id: string) => Promise<void>
  onClearFinished: () => Promise<void>
}) {
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')

  const done = queue.items.filter((item) => item.status === 'done').length
  const openable = queue.items.some(
    (item) => item.status !== 'done' && item.error === undefined,
  )

  async function submit() {
    const text = draft.trim()
    if (text === '') {
      setComposing(false)
      return
    }
    await onAdd(text)
    setDraft('')
    setComposing(false)
  }

  return (
    <section className="queue-panel">
      <div className="queue-head">
        <h3>Queue</h3>
        {queue.items.length > 0 ? (
          <span className="queue-count">
            {done} / {queue.items.length} done
          </span>
        ) : null}
      </div>

      {queue.items.length > 0 ? (
        <ol className="queue-list">
          {queue.items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              isActive={item.id === queue.activeId}
              busy={busy}
              onOpen={(id) => void onOpen(id)}
              onRemove={(id) => void onRemove(id)}
            />
          ))}
        </ol>
      ) : (
        <p className="queue-empty">Paste pull request links to line up a review session.</p>
      )}

      {composing ? (
        <div className="queue-compose">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            autoFocus
            placeholder={PLACEHOLDER}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                if (!busy) void submit()
              }
              if (e.key === 'Escape') {
                setComposing(false)
                setDraft('')
              }
            }}
          />
          <div className="queue-compose-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void submit()}>
              Add
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                setComposing(false)
                setDraft('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="queue-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setComposing(true)}>
            Add PRs
          </button>
          {openable ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void onNext()}>
              {queue.activeId === null ? 'Start' : 'Next'}
            </button>
          ) : null}
          {done > 0 ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => void onClearFinished()}
            >
              Clear done
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}
