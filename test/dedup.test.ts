import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUnifiedDiff } from '../src/context/diff.ts';
import { dedupeFindings } from '../src/pipeline/dedup.ts';
import { coerceFindings } from '../src/pipeline/experts.ts';
import type { ExpertResult, RawFinding } from '../src/types.ts';
import { SAMPLE_DIFF, testConfig, testRegistry } from './helpers.ts';

const config = testConfig();
const registry = testRegistry(config);
const parsed = parseUnifiedDiff(SAMPLE_DIFF);

function raw(overrides: Partial<RawFinding> = {}): RawFinding {
  return {
    file: 'src/app.ts',
    start_line: 12,
    end_line: 12,
    side: 'RIGHT',
    severity: 'medium',
    confidence: 0.8,
    category: 'n-plus-one',
    title: 'loop issues one query per id',
    rationale: 'r',
    evidence: 'src/app.ts:12',
    scenario: 's',
    suggested_fix: 'batch the query',
    suggestion_patch: null,
    ...overrides,
  };
}

function result(agentId: string, findings: RawFinding[]): ExpertResult {
  return { agentId, ok: true, durationMs: 1, error: null, notes: null, findings };
}

describe('dedupeFindings', () => {
  it('anchors findings onto diff lines', () => {
    const [finding] = dedupeFindings({ config, registry, parsed, results: [result('performance', [raw()])] });
    assert.equal(finding?.anchor?.line, 12);
    assert.equal(finding?.anchor?.side, 'RIGHT');
    assert.equal(finding?.id, 'F1');
    assert.ok(finding?.fingerprint);
  });

  it('merges the same issue reported by two personas', () => {
    const merged = dedupeFindings({
      config,
      registry,
      parsed,
      results: [
        result('performance', [raw({ severity: 'medium', confidence: 0.7 })]),
        result('architect', [raw({ severity: 'high', confidence: 0.8, title: 'one query per id in the loop' })]),
      ],
    });
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]?.agents.sort(), ['architect', 'performance']);
    assert.equal(merged[0]?.severity, 'high', 'keeps the highest severity');
    assert.ok((merged[0]?.confidence ?? 0) > 0.8, 'independent agreement raises confidence');
  });

  it('gives ownership to the higher-authority persona', () => {
    const merged = dedupeFindings({
      config,
      registry,
      parsed,
      results: [
        result('architect', [raw({ category: 'coupling', title: 'repository leaks into the service' })]),
        result('consistency', [raw({ category: 'coupling', title: 'repository leaks into the service' })]),
      ],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.owner, 'consistency');
  });

  it('keeps unrelated findings apart', () => {
    const merged = dedupeFindings({
      config,
      registry,
      parsed,
      results: [
        result('performance', [raw()]),
        result('security', [raw({ file: 'src/new.ts', start_line: 1, end_line: 1, category: 'missing-authz', title: 'no auth check' })]),
      ],
    });
    assert.equal(merged.length, 2);
  });

  it('marks a finding outside the diff as unanchored instead of dropping it', () => {
    const merged = dedupeFindings({
      config,
      registry,
      parsed,
      results: [result('security', [raw({ file: 'src/untouched.ts', start_line: 3, end_line: 3 })])],
    });
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.anchor, null);
  });

  it('sorts by severity then authority', () => {
    const merged = dedupeFindings({
      config,
      registry,
      parsed,
      results: [
        result('architect', [raw({ severity: 'low', title: 'style', category: 'naming' })]),
        result('security', [raw({ file: 'src/new.ts', start_line: 2, end_line: 2, severity: 'blocker', title: 'rce', category: 'injection' })]),
      ],
    });
    assert.equal(merged[0]?.owner, 'security');
  });
});

describe('coerceFindings', () => {
  it('recovers from loose model output', () => {
    const [finding] = coerceFindings(
      [
        {
          file: 'b/src/app.ts',
          start_line: '12',
          end_line: '10',
          side: 'right',
          severity: 'HIGH',
          confidence: '0.9',
          category: 'N+1 Query',
          title: ' loop query ',
          rationale: 'r',
          evidence: 'e',
          scenario: 's',
          suggested_fix: 'f',
          suggestion_patch: '   ',
        },
      ],
      config,
    );
    assert.equal(finding?.file, 'src/app.ts');
    assert.equal(finding?.side, 'RIGHT');
    assert.equal(finding?.severity, 'high');
    assert.equal(finding?.confidence, 0.9);
    assert.equal(finding?.category, 'n1-query');
    assert.equal(finding?.title, 'loop query');
    assert.equal(finding?.start_line, 10, 'reversed line range is corrected');
    assert.equal(finding?.end_line, 12);
    assert.equal(finding?.suggestion_patch, null, 'blank patch becomes null');
  });

  it('drops entries with no file or title, and low-confidence guesses', () => {
    const out = coerceFindings(
      [
        { file: '', title: 'x' },
        { file: 'src/app.ts', title: '' },
        { file: 'src/app.ts', title: 'guess', confidence: 0.1 },
        'not an object',
      ],
      config,
    );
    assert.equal(out.length, 0);
  });
});
