import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractIssueKeys, fetchLinkedIssues } from '../src/context/issues.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { PullRequestInfo } from '../src/types.ts';
import { createLogger, setLogLevel } from '../src/util/logger.ts';

setLogLevel('error');

const tracker = DEFAULT_CONFIG.context.issues;

function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    owner: 'acme',
    repo: 'app',
    number: 1,
    title: 'feat(progress): 진행 시작 (MOI-404)',
    body: 'Closes MOI-404',
    author: 'dev',
    baseRef: 'dev',
    headRef: 'moi-404-progress',
    baseSha: 'a',
    headSha: 'b',
    isFork: false,
    htmlUrl: '',
    ...overrides,
  };
}

describe('extractIssueKeys', () => {
  it('finds the key once even when title, body and branch all mention it', () => {
    assert.deepEqual(extractIssueKeys(pr(), tracker.keyPattern, 3), ['MOI-404']);
  });

  it('reads the key from the branch name alone', () => {
    const keys = extractIssueKeys(pr({ title: 'wip', body: '', headRef: 'moi-416-review-swarm' }), tracker.keyPattern, 3);
    assert.deepEqual(keys, ['MOI-416']);
  });

  it('keeps multiple distinct keys in first-seen order, capped', () => {
    const keys = extractIssueKeys(
      pr({ title: 'MOI-1 and MOI-2', body: 'also PLA-9 and MOI-3', headRef: 'x' }),
      tracker.keyPattern,
      3,
    );
    assert.deepEqual(keys, ['MOI-1', 'MOI-2', 'PLA-9']);
  });

  it('does not mistake ordinary hyphenated words for keys', () => {
    const keys = extractIssueKeys(pr({ title: 'fix utf-8 and http-2', body: '', headRef: 'x' }), tracker.keyPattern, 3);
    assert.deepEqual(keys, []);
  });

  it('returns nothing for an unparsable pattern rather than throwing', () => {
    assert.deepEqual(extractIssueKeys(pr(), '([', 3), []);
  });
});

describe('fetchLinkedIssues', () => {
  const logger = createLogger('test');

  it('is a no-op when disabled', async () => {
    const issues = await fetchLinkedIssues(pr(), { ...tracker, enabled: false }, logger, {});
    assert.deepEqual(issues, []);
  });

  it('degrades to empty when the API key is missing', async () => {
    // The review must still run; it just loses intent context.
    const issues = await fetchLinkedIssues(pr(), tracker, logger, {});
    assert.deepEqual(issues, []);
  });

  it('returns nothing when the PR references no issue', async () => {
    const issues = await fetchLinkedIssues(
      pr({ title: 'chore: tidy', body: '', headRef: 'tidy' }),
      tracker,
      logger,
      { LINEAR_API_KEY: 'lin_api_x' },
    );
    assert.deepEqual(issues, []);
  });
});
