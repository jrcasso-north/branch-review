import type { ReactNode } from 'react'
import type { DiffFile } from './types'

type IconProps = {
  className?: string
  title?: string
}

function Svg({
  children,
  className,
  title,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M1.5 4h4l1 1.25H14.5v7.25a1.25 1.25 0 0 1-1.25 1.25H2.75A1.25 1.25 0 0 1 1.5 12.5V4Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M3.75 1.75h5.19L12.25 5.06v9.19a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M8.75 1.75V4.5a1 1 0 0 0 1 1h2.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function StatusAddedIcon(props: IconProps) {
  return (
    <Svg {...props} title={props.title ?? 'Added'}>
      <path
        d="M8 3.25v9.5M3.25 8h9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function StatusDeletedIcon(props: IconProps) {
  return (
    <Svg {...props} title={props.title ?? 'Deleted'}>
      <path
        d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Svg>
  )
}

/** Stacked +/- like GitHub’s modified marker. */
export function StatusModifiedIcon(props: IconProps) {
  return (
    <Svg {...props} title={props.title ?? 'Modified'}>
      <path
        d="M8 2.75v4.5M5.75 5h4.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M5.5 11.25h5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function StatusRenamedIcon(props: IconProps) {
  return (
    <Svg {...props} title={props.title ?? 'Renamed'}>
      <path
        d="M2.75 8h8.5M8.5 4.75 11.75 8 8.5 11.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function StatusIcon({
  status,
  className,
}: {
  status: DiffFile['status']
  className?: string
}) {
  switch (status) {
    case 'added':
      return <StatusAddedIcon className={className} />
    case 'deleted':
      return <StatusDeletedIcon className={className} />
    case 'renamed':
      return <StatusRenamedIcon className={className} />
    default:
      return <StatusModifiedIcon className={className} />
  }
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M12.6 3.4l-1.06 1.06M4.46 11.54l-1.06 1.06"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M11.5 10.1A4.75 4.75 0 0 1 5.9 3.7 5.1 5.1 0 1 0 11.5 10.1Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** GitHub-style commit marker: a bead on a horizontal string. */
export function CommitIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M1.5 8h4.25M10.25 8H14.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="8" cy="8" r="2.35" stroke="currentColor" strokeWidth="1.25" />
    </Svg>
  )
}

/** Two arrows from below that join into one shared head. */
export function MergeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M4.25 13.25 8 6.5 11.75 13.25M8 6.5V2.75M5.75 4.75 8 2.75l2.25 2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function CommentBubbleIcon({
  solid = false,
  ...props
}: IconProps & { solid?: boolean }) {
  return (
    <Svg {...props} className={props.className}>
      <path
        d="M2.5 2.75h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7.2L4 14.25v-2.999H2.5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1Z"
        fill={solid ? 'var(--edit-mark-bg)' : 'none'}
        stroke={solid ? 'var(--edit-mark)' : 'currentColor'}
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function CaretLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M9.75 3.25 5.25 8l4.5 4.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function CaretRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M6.25 3.25 10.75 8l-4.5 4.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function EditIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M9.6 3.15 12.85 6.4 5.7 13.55H2.45v-3.25L9.6 3.15Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M8.35 4.4 11.6 7.65"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M3.25 4.5h9.5M6.25 4.5V3.4c0-.5.4-.9.9-.9h1.7c.5 0 .9.4.9.9V4.5M5.1 4.5l.55 8.1c.05.55.5.95 1.05.95h2.6c.55 0 1-.4 1.05-.95l.55-8.1"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

export function CheckboxIcon({
  checked = false,
  ...props
}: IconProps & { checked?: boolean }) {
  return (
    <Svg {...props}>
      <rect
        x="2.25"
        y="2.25"
        width="11.5"
        height="11.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.25"
        fill={checked ? 'currentColor' : 'none'}
      />
      {checked ? (
        <path
          d="M5.1 8.15 7.05 10.1 11 5.9"
          stroke="var(--surface)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </Svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M3.5 8.25 6.6 11.25 12.5 4.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** Sparkle: hand this comment to an agent. */
export function AgentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M7.25 2.5 8.4 6.1 12 7.25 8.4 8.4 7.25 12 6.1 8.4 2.5 7.25 6.1 6.1Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11.9 10.1 12.4 11.6 13.9 12.1 12.4 12.6 11.9 14.1 11.4 12.6 9.9 12.1 11.4 11.6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

/** Undo: from bottom-left → right → up → arrowhead pointing left. */
export function UndoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M3.75 11.25h5.5a3.75 3.75 0 0 0 0-7.5H5.35"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.2 2.35 4.5 3.75 7.2 5.15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

