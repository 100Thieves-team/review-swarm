const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

let current: LogLevel = (process.env.SWARM_LOG_LEVEL as LogLevel) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, scope: string, message: string): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.padEnd(5)} [${scope}] ${message}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'swarm'): Logger {
  return {
    debug: (m) => emit('debug', scope, m),
    info: (m) => emit('info', scope, m),
    warn: (m) => emit('warn', scope, m),
    error: (m) => emit('error', scope, m),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger();

/** GitHub Actions log grouping, no-op outside Actions. */
export function group<T>(title: string, fn: () => Promise<T>): Promise<T> {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  if (inActions) process.stdout.write(`::group::${title}\n`);
  return fn().finally(() => {
    if (inActions) process.stdout.write('::endgroup::\n');
  });
}

/**
 * Time a stage, log its duration and record it.
 *
 * Wall-clock per stage is the only way to tell whether a slow run was the expert
 * fan-out, the verifier or the mediator — without it, tuning is guesswork.
 */
export async function timedStage<T>(
  title: string,
  timings: Record<string, number>,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await group(title, fn);
  } finally {
    const elapsed = Date.now() - startedAt;
    timings[title] = elapsed;
    logger.info(`stage "${title}" ${(elapsed / 1000).toFixed(1)}s`);
  }
}
