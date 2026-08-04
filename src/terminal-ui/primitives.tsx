import type { ReactNode } from 'react'
import { Box, Text } from 'ink'

/** Static Ink primitives following termcn's copy-in component model. */
export const colors = {
  accent: '#a78bfa',
  border: '#4b5563',
  danger: '#f87171',
  foreground: '#f9fafb',
  muted: '#9ca3af',
  mutedBar: '#374151',
  success: '#34d399',
  warning: '#fbbf24',
} as const

const unicode = process.env.NO_UNICODE !== '1' && process.env.NO_UNICODE !== 'true'

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color={colors.accent}>{title}</Text>
        {hint ? <Text color={colors.muted}>  {hint}</Text> : null}
      </Box>
      <Box marginTop={1} flexDirection="column">{children}</Box>
    </Box>
  )
}

export interface BarChartItem {
  label: string
  value: number
  displayValue?: string
  color?: string
  /** Stable React key when labels can repeat (added and removed routes sharing a pattern). */
  key?: string
}

/** Horizontal bar chart based on termcn's BarChart API and visual grammar. */
export function BarChart({ data, width }: { data: BarChartItem[]; width: number }) {
  if (data.length === 0) return <Text color={colors.muted}>No data</Text>

  const labelWidth = Math.min(30, Math.max(...data.map((item) => item.label.length)))
  const valueWidth = Math.max(...data.map((item) => (item.displayValue ?? String(item.value)).length))
  const barWidth = Math.max(6, width - labelWidth - valueWidth - 4)
  const max = Math.max(0, ...data.map((item) => item.value))
  const full = unicode ? '█' : '#'
  const empty = unicode ? '░' : '-'

  return (
    <Box flexDirection="column">
      {data.map((item, index) => {
        const filled = max === 0 ? 0 : Math.max(1, Math.round((item.value / max) * barWidth))
        const label = truncate(item.label, labelWidth)
        return (
          <Box key={item.key ?? `${item.label}:${item.displayValue ?? item.value}:${index}`}>
            <Text>{label.padEnd(labelWidth)}  </Text>
            <Text color={item.color ?? colors.accent}>{full.repeat(filled)}</Text>
            <Text color={colors.mutedBar}>{empty.repeat(Math.max(0, barWidth - filled))}</Text>
            <Text color={colors.muted}>  {(item.displayValue ?? String(item.value)).padStart(valueWidth)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export interface TableColumn<T> {
  header: string
  width: number
  align?: 'left' | 'right' | 'center'
  value: (row: T) => string
}

/** A static, pipe-safe variant of termcn's bordered Table. */
export function Table<T>({ rows, columns, maxRows = 50 }: { rows: T[]; columns: TableColumn<T>[]; maxRows?: number }) {
  const chars = unicode
    ? { tl: '╭', tm: '┬', tr: '╮', ml: '├', mm: '┼', mr: '┤', bl: '╰', bm: '┴', br: '╯', h: '─', v: '│' }
    : { tl: '+', tm: '+', tr: '+', ml: '+', mm: '+', mr: '+', bl: '+', bm: '+', br: '+', h: '-', v: '|' }
  const line = (left: string, middle: string, right: string) =>
    left + columns.map((column) => chars.h.repeat(column.width + 2)).join(middle) + right
  const visible = rows.slice(0, maxRows)

  return (
    <Box flexDirection="column">
      <Text color={colors.border}>{line(chars.tl, chars.tm, chars.tr)}</Text>
      <Box>
        <Text color={colors.border}>{chars.v}</Text>
        {columns.map((column) => (
          <Box key={column.header}>
            <Text bold color={colors.accent}> {pad(column.header, column.width, column.align)} </Text>
            <Text color={colors.border}>{chars.v}</Text>
          </Box>
        ))}
      </Box>
      <Text color={colors.border}>{line(chars.ml, chars.mm, chars.mr)}</Text>
      {visible.map((row, rowIndex) => (
        <Box key={rowIndex}>
          <Text color={colors.border}>{chars.v}</Text>
          {columns.map((column) => (
            <Box key={column.header}>
              <Text> {pad(column.value(row), column.width, column.align)} </Text>
              <Text color={colors.border}>{chars.v}</Text>
            </Box>
          ))}
        </Box>
      ))}
      {rows.length > maxRows ? (
        <Box>
          <Text color={colors.border}>{chars.v}</Text>
          <Text color={colors.muted}> {`${rows.length - maxRows} more rows`.padEnd(tableInnerWidth(columns))} </Text>
          <Text color={colors.border}>{chars.v}</Text>
        </Box>
      ) : null}
      <Text color={colors.border}>{line(chars.bl, chars.bm, chars.br)}</Text>
    </Box>
  )
}

function tableInnerWidth<T>(columns: TableColumn<T>[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0) + columns.length * 3 - 1
}

function pad(value: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const text = truncate(value, width)
  const gap = Math.max(0, width - text.length)
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }
  return text + ' '.repeat(gap)
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return value.slice(0, width - 1) + (unicode ? '…' : '.')
}
