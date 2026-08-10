import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SwarmConfig } from '../config.ts';
import type { CheckResult, PullRequestInfo, ReviewContext } from '../types.ts';
import { git, run } from '../util/exec.ts';
import { matchesAnyGlob } from '../util/glob.ts';
import type { Logger } from '../util/logger.ts';
import { truncate, truncateTail } from '../util/text.ts';
import { changedFiles as toChangedFiles, parseUnifiedDiff, renderDiff, type ParsedDiff } from './diff.ts';

export interface CollectOptions {
  config: SwarmConfig;
  workdir: string;
  runDir: string;
  runId: string;
  pr: PullRequestInfo;
  /** Override the diff base — used to review only what a new push added. */
  baseOverride?: string;
  logger: Logger;
}

export interface CollectedContext {
  context: ReviewContext;
  parsed: ParsedDiff;
  /** Files present in the raw diff but filtered out by `ignore`. */
  ignoredFiles: string[];
}

export async function collectContext(options: CollectOptions): Promise<CollectedContext> {
  const { config, workdir, runDir, runId, pr, logger } = options;
  mkdirSync(runDir, { recursive: true });

  const head = await resolveCommit(workdir, pr.headSha, pr.headRef, logger);
  const requestedBase = options.baseOverride ?? pr.baseSha;
  const base = await resolveCommit(workdir, requestedBase, pr.baseRef, logger);
  const range = await mergeBase(workdir, base, head, logger);

  const rawDiff = await git(
    [
      'diff',
      `--unified=${config.context.diffContextLines}`,
      '--no-color',
      '--find-renames',
      '--no-ext-diff',
      `${range}`,
      head,
    ],
    workdir,
  );

  const rawParsed = parseUnifiedDiff(rawDiff);
  const ignoredFiles: string[] = [];
  const keptPaths: string[] = [];
  for (const file of rawParsed.files.values()) {
    if (matchesAnyGlob(file.path, config.ignore)) ignoredFiles.push(file.path);
    else keptPaths.push(file.path);
  }

  const filteredDiff = truncate(renderDiff(rawParsed, keptPaths), config.context.maxDiffChars);
  const parsed = parseUnifiedDiff(filteredDiff);
  const changedFiles = toChangedFiles(parsed);

  const diffPath = join(runDir, 'diff.patch');
  writeFileSync(diffPath, filteredDiff, 'utf8');

  const checks = await runChecks(config, workdir, logger);
  const teamRules = readTeamRules(config, workdir);

  const context: ReviewContext = {
    runId,
    workdir,
    runDir,
    pr,
    diff: filteredDiff,
    diffPath,
    changedFiles,
    checks,
    teamRules,
  };

  writeFileSync(join(runDir, 'context.json'), JSON.stringify({ ...context, diff: undefined }, null, 2), 'utf8');
  logger.info(
    `diff: ${changedFiles.length} files, ${changedFiles.reduce((n, f) => n + f.additions + f.deletions, 0)} changed lines` +
      (ignoredFiles.length ? `, ${ignoredFiles.length} ignored` : ''),
  );

  return { context, parsed, ignoredFiles };
}

/** Make sure a commit is present locally; shallow CI clones usually are not enough. */
async function resolveCommit(workdir: string, sha: string, ref: string, logger: Logger): Promise<string> {
  const candidates = [sha, `origin/${ref}`, ref].filter(Boolean);

  for (const candidate of candidates) {
    if (await hasCommit(workdir, candidate)) return candidate;
  }

  for (const candidate of candidates) {
    const fetched = await run('git', ['fetch', '--no-tags', '--depth=200', 'origin', candidate], {
      cwd: workdir,
      timeoutMs: 180_000,
    });
    if (fetched.code === 0 && (await hasCommit(workdir, candidate))) {
      logger.debug(`fetched ${candidate}`);
      return candidate;
    }
  }

  // Last resort: unshallow, which is slow but always correct.
  await run('git', ['fetch', '--no-tags', '--unshallow', 'origin'], { cwd: workdir, timeoutMs: 600_000 });
  for (const candidate of candidates) {
    if (await hasCommit(workdir, candidate)) return candidate;
  }
  throw new Error(`cannot resolve commit for ${sha} / ${ref}; fetch the base branch before running the swarm`);
}

async function hasCommit(workdir: string, rev: string): Promise<boolean> {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
    cwd: workdir,
    timeoutMs: 30_000,
  });
  return result.code === 0;
}

async function mergeBase(workdir: string, base: string, head: string, logger: Logger): Promise<string> {
  const result = await run('git', ['merge-base', base, head], { cwd: workdir, timeoutMs: 60_000 });
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  logger.warn(`no merge-base between ${base} and ${head}; diffing against ${base} directly`);
  return base;
}

async function runChecks(config: SwarmConfig, workdir: string, logger: Logger): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of config.checks) {
    logger.info(`check: ${check.name}`);
    const result = await run('/bin/sh', ['-c', check.run], { cwd: workdir, timeoutMs: check.timeoutMs });
    results.push({
      name: check.name,
      command: check.run,
      exitCode: result.timedOut ? -1 : result.code,
      timedOut: result.timedOut,
      output: truncateTail(`${result.stdout}\n${result.stderr}`.trim(), check.maxOutputChars),
    });
  }
  return results;
}

function readTeamRules(config: SwarmConfig, workdir: string): string {
  const sections: string[] = [];
  let budget = config.context.maxTeamRuleChars;

  for (const relative of config.context.teamRuleFiles) {
    if (budget <= 0) break;
    const path = resolve(workdir, relative);
    if (!existsSync(path)) continue;
    try {
      const body = truncate(readFileSync(path, 'utf8').trim(), budget);
      if (!body) continue;
      sections.push(`### ${relative}\n${body}`);
      budget -= body.length;
    } catch {
      // An unreadable rules file must not abort the review.
    }
  }

  return sections.join('\n\n');
}
