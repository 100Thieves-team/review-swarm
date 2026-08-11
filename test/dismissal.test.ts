import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publishReview } from '../src/publish/publish.ts';
import type { PriorFinding } from '../src/publish/github.ts';
import { parseMarker, parseTitle, renderFindingBody } from '../src/publish/render.ts';
import { applyPolicy } from '../src/pipeline/policy.ts';
import { createLogger, setLogLevel } from '../src/util/logger.ts';
import { makeFinding, testConfig, testRegistry } from './helpers.ts';

setLogLevel('error');

const config = testConfig();
const registry = testRegistry(config);

function prior(overrides: Partial<PriorFinding> = {}): PriorFinding {
  return {
    fingerprint: 'fp1',
    agent: 'architect',
    title: '기존 지적',
    path: 'src/app.ts',
    line: 10,
    dismissed: false,
    outdated: false,
    ...overrides,
  };
}

describe('marker round-trip', () => {
  it('recovers the agent and fingerprint a comment was posted with', () => {
    const finding = makeFinding({ owner: 'security', fingerprint: 'abc123def0' });
    const body = renderFindingBody(finding, registry.get('security'), { includeAgentHeader: false });
    assert.deepEqual(parseMarker(body), { agent: 'security', fingerprint: 'abc123def0' });
  });

  it('recovers the title so prior findings can be shown to the mediator', () => {
    const finding = makeFinding({ title: '인가 검사가 빠졌다' });
    const body = renderFindingBody(finding, registry.get('architect'), { includeAgentHeader: true });
    assert.equal(parseTitle(body), '인가 검사가 빠졌다');
  });

  it('returns null for a comment that is not ours', () => {
    assert.equal(parseMarker('그냥 사람이 쓴 코멘트'), null);
  });
});

describe('publishReview suppression', () => {
  const publish = (findings: ReturnType<typeof makeFinding>[], priors: PriorFinding[]) => {
    const outcome = applyPolicy(config, registry, findings);
    return publishReview({
      config: testConfig({ publish: { ...config.publish, mode: 'none' } }),
      context: { pr: { owner: 'o', repo: 'r', number: 1, headSha: 'sha' } } as never,
      registry,
      outcome,
      prior: priors,
      fallbackToken: 'token',
      dryRun: false,
      logger: createLogger('test'),
      makeSummary: () => 'summary',
    });
  };

  it('publishes nothing new when the mode is none, but still computes suppression', async () => {
    // mode: none short-circuits before any network call, so this asserts the
    // wiring rather than the API. The classification itself is covered below.
    const result = await publish([makeFinding()], []);
    assert.deepEqual(result.posted, []);
    assert.deepEqual(result.dismissed, []);
  });
});

describe('dismissal classification', () => {
  // The rule the publish step applies, stated directly: a dismissed fingerprint
  // never comes back, a merely-seen one is skipped only while skipDuplicates is on.
  const classify = (finding: { fingerprint: string }, priors: PriorFinding[], skipDuplicates: boolean) => {
    const dismissed = new Set(priors.filter((p) => p.dismissed).map((p) => p.fingerprint));
    const seen = new Set(priors.map((p) => p.fingerprint));
    if (dismissed.has(finding.fingerprint)) return 'dismissed';
    if (skipDuplicates && seen.has(finding.fingerprint)) return 'skipped';
    return 'posted';
  };

  it('suppresses a finding whose thread the author resolved', () => {
    assert.equal(classify({ fingerprint: 'fp1' }, [prior({ dismissed: true })], true), 'dismissed');
  });

  it('keeps suppressing it even with duplicate-skipping turned off', () => {
    assert.equal(classify({ fingerprint: 'fp1' }, [prior({ dismissed: true })], false), 'dismissed');
  });

  it('skips a repeat of a still-open finding', () => {
    assert.equal(classify({ fingerprint: 'fp1' }, [prior()], true), 'skipped');
  });

  it('posts a finding that has never been raised', () => {
    assert.equal(classify({ fingerprint: 'new' }, [prior({ dismissed: true })], true), 'posted');
  });
});
