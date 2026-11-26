import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

interface CacheEntry {
  mtimeMs: number
  text: string
}

const cache = new Map<string, CacheEntry>()

export function configDirectory(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
}

/**
 * Advisor-only guidance files, in prompt order: the user file first, then
 * project files from the outermost ancestor down to the working directory.
 */
export function discoverWatchdogFiles(directory: string, projectRoot?: string): string[] {
  const files: string[] = []
  const userFile = join(configDirectory(), "WATCHDOG.md")
  if (existsSync(userFile)) files.push(userFile)

  const start = resolve(directory)
  const stop = projectRoot ? resolve(projectRoot) : resolve(homedir())
  const chain: string[] = []
  let current = start
  while (true) {
    chain.push(current)
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  for (const dir of chain.reverse()) {
    for (const candidate of [join(dir, "WATCHDOG.md"), join(dir, ".opencode", "WATCHDOG.md")]) {
      if (existsSync(candidate) && !files.includes(candidate)) files.push(candidate)
    }
  }
  return files
}

function readCached(path: string): string | undefined {
  try {
    const stat = statSync(path)
    const cached = cache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text
    const text = readFileSync(path, "utf8")
    cache.set(path, { mtimeMs: stat.mtimeMs, text })
    return text
  } catch {
    return undefined
  }
}

export function loadWatchdog(directory: string, projectRoot: string | undefined, enabled: boolean): string {
  if (!enabled) return ""
  const blocks: string[] = []
  for (const file of discoverWatchdogFiles(directory, projectRoot)) {
    const text = readCached(file)
    if (text && text.trim().length > 0) blocks.push(`<!-- ${file} -->\n${text.trim()}`)
  }
  return blocks.join("\n\n")
}
