import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeTool } from '../makeTool'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function startWorkTool(channelName: string) {
  const slug =
    channelName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'work'
  return makeTool({
    name: 'start_work',
    label: (n) => `Handed off ${plural(n, 'task')} to Claude Code`,
    description:
      'Dispatch a coding task to a Claude Code session running in a detached tmux session on this machine. ' +
      'Use this to hand real work off to Claude Code — you never do the work yourself. ' +
      'The session opens in ~/projects/<channel> and begins by planning the task (`/plan <task>`). ' +
      'It returns immediately and runs in the background. Write a clear, self-contained task: the session ' +
      'has none of this conversation as context.',
    inputSchema: z.object({
      task: z
        .string()
        .describe('A clear, self-contained description of the work to plan and carry out.'),
    }),
    run: async ({ task }) => {
      const dir = join(process.env.WORK_DIR || join(homedir(), 'projects'), slug)
      const session = `munin-${slug}`
      mkdirSync(dir, { recursive: true })
      try {
        execFileSync('tmux', ['has-session', '-t', session], {
          stdio: 'ignore',
        })
        return `A work session (${session}) is already running for this channel; leaving it alone. Attach with \`tmux attach -t ${session}\`.`
      } catch {
        // no session by that name; create one
      }
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s',
        session,
        '-c',
        dir,
        'env',
        '-u',
        'ANTHROPIC_API_KEY',
        'claude',
        `/plan ${task}`,
      ])
      return `Launched an interactive Claude Code session in ${dir} (tmux session ${session}) to plan: ${task}. Attach with \`tmux attach -t ${session}\` to watch or continue.`
    },
    arbitraryOutreach: true,
  })
}
