import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  timeoutMs?: number;
  /** Keep at most this many bytes of stdout/stderr in memory. */
  maxBuffer?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Spawn a command without a shell and collect its output.
 *
 * Never rejects on a non-zero exit — callers branch on `code`, because a failing
 * expert must degrade the run, not crash it.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, stdin, timeoutMs = 0, maxBuffer = 16 * 1024 * 1024 } = options;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Escalate if the child ignores SIGTERM.
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
          }, timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxBuffer) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxBuffer) stderr += chunk;
    });

    child.on('error', (err) => {
      stderr += `\n${String(err)}`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? -1));

    if (stdin !== undefined) {
      child.stdin.end(stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

/** `run` for git, throwing on failure because a broken repo is not recoverable. */
export async function git(args: string[], cwd: string): Promise<string> {
  const result = await run('git', args, { cwd, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}
