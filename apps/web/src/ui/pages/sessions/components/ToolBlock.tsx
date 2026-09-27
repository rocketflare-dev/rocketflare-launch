/**
 * A run of Claude Code tool calls as ONE quiet block of one-liners (D7's rule for tool calls: a
 * call and its answer are one row that spins until it returns). The wording is `toolSummary` —
 * "Edited …/components/Header.tsx", "Ran pnpm test" — because in a coding session the file and the
 * command ARE the information; the raw input and result sit behind the row's own disclosure
 * (the run timeline's `pretty` / `truncate`, capped at `TOOL_RESULT_MAX_CHARS`).
 *
 * A long block shows its last few rows and one "show earlier" button — it windows, it does not
 * virtualise (ui.md) — and opens fully once the reader asks.
 */
import {
  ChevronRightIcon,
  CommandLineIcon,
  DocumentMagnifyingGlassIcon,
  DocumentTextIcon,
  ExclamationCircleIcon,
  PencilSquareIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline'
import { type ComponentType, useState } from 'react'
import { formatDuration } from '@/ui/lib/format'
import type { ToolRow } from '@/ui/pages/agents/run/timeline/timelineModel'
import { pretty, truncate } from '@/ui/pages/agents/run/timeline/toolResults'
import { toolSummary } from '../sessionChatModel'

/** Rows shown before "show earlier" appears. */
export const TOOL_BLOCK_WINDOW = 4

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Read: DocumentTextIcon,
  Edit: PencilSquareIcon,
  MultiEdit: PencilSquareIcon,
  Write: PencilSquareIcon,
  NotebookEdit: PencilSquareIcon,
  Bash: CommandLineIcon,
  Grep: DocumentMagnifyingGlassIcon,
  Glob: DocumentMagnifyingGlassIcon,
  LS: DocumentMagnifyingGlassIcon,
}

function ToolLine({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false)
  const { verb, target } = toolSummary(row.name, row.input)
  const Icon = ICONS[row.name] ?? WrenchScrewdriverIcon
  const hasDetail = row.input !== undefined || row.result !== undefined
  return (
    <li data-event-kind="tool" data-tool={row.name}>
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-base-200 disabled:cursor-default disabled:hover:bg-transparent"
        onClick={() => setOpen(v => !v)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? open : undefined}
      >
        {!row.done ? (
          <span
            className="loading loading-spinner loading-xs shrink-0 text-muted"
            role="img"
            aria-label="running"
          />
        ) : row.isError ? (
          <ExclamationCircleIcon className="w-3.5 h-3.5 shrink-0 text-error" aria-label="failed" />
        ) : (
          <Icon className="w-3.5 h-3.5 shrink-0 text-muted" />
        )}
        <span className="min-w-0 flex-1 truncate">
          <span className={row.isError ? 'text-error' : 'text-secondary'}>{verb}</span>
          {target && <span className="ml-1 font-mono text-[0.7rem]">{target}</span>}
        </span>
        {row.durationMs !== undefined && row.durationMs >= 1000 && (
          <span className="text-muted tabular-nums shrink-0">{formatDuration(row.durationMs)}</span>
        )}
        {hasDetail && (
          <ChevronRightIcon
            className={`w-3 h-3 shrink-0 text-muted opacity-0 group-hover:opacity-100 transition-transform ${open ? 'rotate-90 opacity-100' : ''}`}
          />
        )}
      </button>
      {open && hasDetail && (
        <pre className="surface-inset rounded-md p-2 mt-1 ml-6 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">
          {truncate(
            pretty({
              ...(row.input !== undefined ? { input: row.input } : {}),
              ...(row.result !== undefined ? { result: row.result } : {}),
            })
          )}
        </pre>
      )}
    </li>
  )
}

export function ToolBlock({ rows }: { rows: readonly ToolRow[] }) {
  const [expanded, setExpanded] = useState(false)
  const hidden = expanded ? 0 : Math.max(0, rows.length - TOOL_BLOCK_WINDOW)
  const running = rows.filter(r => !r.done).length
  return (
    <div
      className="ml-1 border-l-2 border-[color:var(--border-subtle)] pl-2.5"
      aria-label={`${rows.length} ${rows.length === 1 ? 'step' : 'steps'}${running ? `, ${running} running` : ''}`}
      role="group"
    >
      {hidden > 0 && (
        <button
          type="button"
          className="px-1.5 py-0.5 text-xs text-muted hover:underline"
          onClick={() => setExpanded(true)}
        >
          Show {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
        </button>
      )}
      <ul className="space-y-0.5">
        {rows.slice(hidden).map(row => (
          <ToolLine key={row.id} row={row} />
        ))}
      </ul>
    </div>
  )
}
