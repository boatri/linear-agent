#!/usr/bin/env bun
/**
 * Scans local Claude Code JSONL session files for tool_use entries
 * and reports any tools not covered by TOOL_MAPPING.
 *
 * Usage:
 *   bun scripts/find-unmapped-tools.ts                     # all sessions
 *   bun scripts/find-unmapped-tools.ts --since 7d          # last 7 days
 *   bun scripts/find-unmapped-tools.ts --since 2026-03-01  # since date
 *   bun scripts/find-unmapped-tools.ts --dir ~/other/path  # custom dir
 */
import { Glob } from 'bun'
import { statSync } from 'fs'
import { Marked } from 'marked'
// @ts-expect-error no types available
import { markedTerminal } from 'marked-terminal'
import { TOOL_MAPPING } from '../src/claude/tool-mapping'

const md = new Marked(markedTerminal({ width: process.stdout.columns ?? 80 }))

function parseArgs() {
  let dir = `${process.env.HOME}/.claude/projects`
  let since: Date | null = null

  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      dir = args[++i]
    } else if (args[i] === '--since' && args[i + 1]) {
      since = parseSince(args[++i])
    }
  }

  return { dir, since }
}

function parseSince(value: string): Date {
  // Relative: "7d", "24h", "2w"
  const match = value.match(/^(\d+)([dhw])$/)
  if (match) {
    const n = parseInt(match[1])
    const unit = match[2]
    const ms = unit === 'h' ? n * 3600_000 : unit === 'd' ? n * 86400_000 : n * 7 * 86400_000
    return new Date(Date.now() - ms)
  }
  // Absolute: ISO date string
  const date = new Date(value)
  if (isNaN(date.getTime())) {
    console.error(`Invalid --since value: ${value}`)
    process.exit(1)
  }
  return date
}

const { dir, since } = parseArgs()
const mapped = new Set(Object.keys(TOOL_MAPPING))

const counts = new Map<string, number>()
const examples = new Map<string, string[]>()

let filesScanned = 0
let filesSkipped = 0

for await (const path of new Glob('**/*.jsonl').scan(dir)) {
  const fullPath = `${dir}/${path}`

  if (since) {
    try {
      const stat = statSync(fullPath)
      if (stat.mtime < since) {
        filesSkipped++
        continue
      }
    } catch {
      continue
    }
  }

  filesScanned++
  const file = Bun.file(fullPath)
  const text = await file.text()

  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue
    try {
      const entry = JSON.parse(line)
      const blocks = entry?.message?.content
      if (!Array.isArray(blocks)) continue

      for (const block of blocks) {
        if (block.type !== 'tool_use') continue
        const name: string = block.name
        if (mapped.has(name)) continue

        counts.set(name, (counts.get(name) ?? 0) + 1)
        const ex = examples.get(name) ?? []
        if (ex.length < 3) {
          const keys = Object.keys(block.input ?? {}).join(', ')
          ex.push(keys || '(no input)')
          examples.set(name, ex)
        }
      }
    } catch {
      // skip malformed lines
    }
  }
}

const sinceLabel = since ? ` (since ${since.toISOString().slice(0, 10)})` : ''
const skippedLabel = filesSkipped ? `, skipped ${filesSkipped} older` : ''

let output = `*Scanned ${filesScanned} files${skippedLabel}${sinceLabel}*\n\n`

if (counts.size === 0) {
  output += '**All tools are mapped!**\n'
} else {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  output += `**${sorted.length} unmapped tool(s):**\n\n`
  output += '| Tool | Uses | Input keys (sample) |\n'
  output += '|------|------|--------------------|\n'
  for (const [name, count] of sorted) {
    const ex = examples.get(name) ?? []
    const unique = [...new Set(ex)]
    output += `| ${name} | ${count} | ${unique.join(', ')} |\n`
  }
}

process.stdout.write(md.parse(output) as string)
