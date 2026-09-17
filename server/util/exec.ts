import { execFile, spawn } from 'node:child_process'

export interface ExecResult {
  stdout: string
  stderr: string
}

export class ExecError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} exited ${code ?? 'signal'}: ${stderr.trim() || stdout.trim()}`)
    this.name = 'ExecError'
  }
}

/**
 * Runs a binary with an argv array - never a shell string - so that repo URLs,
 * branch names and paths cannot be interpreted as shell syntax.
 */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: opts.env ?? process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null
          reject(new ExecError(`${file} ${args.join(' ')}`, code, stdout, stderr))
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

/**
 * Runs a binary, streaming stdout+stderr line-wise to `onLine` as they arrive.
 * Used for long operations (image builds) where waiting for exit is not an option.
 */
export function spawnStream(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine: (line: string) => void; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    })

    let tail = ''
    const consume = (chunk: Buffer) => {
      tail += chunk.toString('utf8')
      const lines = tail.split(/\r?\n/)
      tail = lines.pop() ?? ''
      for (const line of lines) opts.onLine(line)
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    child.on('error', reject)
    child.on('close', (code) => {
      if (tail.trim() !== '') opts.onLine(tail)
      if (code === 0) resolve()
      else reject(new ExecError(`${file} ${args.join(' ')}`, code, '', `exited with code ${code}`))
    })
  })
}
