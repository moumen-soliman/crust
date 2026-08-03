import { Box, Text, renderToString } from 'ink'
import { Section, colors } from '../terminal-ui/primitives.tsx'
import type { InitFile, InitResult, InitStep } from './init.ts'

const GLYPH: Record<InitStep['status'], string> = { ok: '✓', warn: '!', skip: '•', fail: '✗' }
const STATUS_COLOR: Record<InitStep['status'], string> = {
  ok: colors.success,
  warn: colors.warning,
  skip: colors.muted,
  fail: colors.danger,
}

export function renderInitTerminal(result: InitResult, columns = process.stdout.columns): string {
  const width = Math.max(48, Math.min(columns || 100, 100))
  return renderToString(<InitView result={result} width={width} />, { columns: width })
}

/**
 * Wrap before Ink does.
 *
 * Ink breaks a long line at the terminal edge and carries the separating space
 * onto the next one, so an explanation reads with a stray indent halfway through
 * a sentence. Doing it here keeps the break at a word and re-applies the
 * original indent, which is what makes the code and path lines line up.
 */
export function wrapText(text: string, width: number): string[] {
  const indent = text.match(/^\s*/)?.[0] ?? ''
  const body = text.slice(indent.length)
  const room = Math.max(8, width - indent.length)
  if (body.length <= room) return [text]

  const lines: string[] = []
  let current = ''
  for (const word of body.split(' ')) {
    if (current === '') current = word
    else if (current.length + 1 + word.length <= room) current += ` ${word}`
    else {
      lines.push(indent + current)
      current = word
    }
  }
  if (current !== '') lines.push(indent + current)
  return lines
}

function InitView({ result, width }: { result: InitResult; width: number }) {
  const titleWidth = Math.max(0, ...result.steps.map((step) => step.title.length))
  const wrote = result.files.filter((file) => file.status !== 'kept')

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" width={width}>
        <Text bold color={colors.accent}>crust init{result.app ? ` — ${result.app.relativeDir}` : ''}</Text>
        <Text color={colors.muted}>
          {result.snapshot ? `Next ${result.snapshot.nextVersion} · ${result.snapshot.bundler}` : 'setup'}
          {result.dryRun ? ' · dry run' : ''}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {result.steps.map((step, index) => {
          // The header row is wrapped here rather than by Ink. A row of Texts
          // that overflows gets re-laid out, and the separating spaces - glyph to
          // title, title to detail - are the first thing that goes, so an
          // overflowing step loses the space after its own status glyph.
          const [detail, ...overflow] = wrapText(step.detail, Math.max(16, width - titleWidth - 4))
          const lines = [...overflow, ...step.lines.flatMap((line) => wrapText(line, width - 4))]

          return (
            <Box key={step.title} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Box>
                <Text color={STATUS_COLOR[step.status]}>{GLYPH[step.status]} </Text>
                <Text bold>{step.title.padEnd(titleWidth)}</Text>
                <Text color={step.status === 'fail' ? colors.danger : colors.muted}>  {detail ?? ''}</Text>
              </Box>
              {/* Padding rather than a literal indent: a line long enough to wrap
                  keeps its offset on the continuation, instead of restarting at
                  column zero and reading as a new bullet. */}
              <Box flexDirection="column" paddingLeft={4}>
                {lines.map((line, lineIndex) => (
                  <Text key={lineIndex} color={colors.muted}>{line}</Text>
                ))}
              </Box>
            </Box>
          )
        })}
      </Box>

      {wrote.length > 0 ? (
        <Section title={result.dryRun ? 'WOULD WRITE' : 'FILES'}>
          {wrote.map((file) => (
            <Text key={file.path}>
              <Text color={colors.success}>{fileGlyph(file)} </Text>
              {file.path}
              {file.detail ? <Text color={colors.muted}>  {file.detail}</Text> : null}
            </Text>
          ))}
        </Section>
      ) : null}

      {result.nextSteps.length > 0 ? (
        <Section title="NEXT">
          {result.nextSteps.map((step, index) => (
            <Box key={index}>
              <Text color={colors.accent}>{index + 1}. </Text>
              <Box flexDirection="column">
                {wrapText(step, width - 3).map((line, lineIndex) => (
                  <Text key={lineIndex}>{line}</Text>
                ))}
              </Box>
            </Box>
          ))}
        </Section>
      ) : null}

      {result.ok ? null : (
        <Box marginTop={1}>
          <Text color={colors.danger}>Setup stopped. Fix the step above and rerun `crust init`.</Text>
        </Box>
      )}
    </Box>
  )
}

const fileGlyph = (file: InitFile): string => (file.status === 'planned' ? '·' : '+')
