import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPolicy, hasScaleEvidence } from '../src/pipeline/policy.ts';
import { makeFinding, testConfig, testRegistry } from './helpers.ts';

const config = testConfig();
const registry = testRegistry(config);

describe('applyPolicy — authority tiers', () => {
  it('escalates a verified, severe safety-gate finding to REQUEST_CHANGE', () => {
    const finding = makeFinding({
      owner: 'security',
      agents: ['security'],
      severity: 'high',
      confidence: 0.9,
      verdict: 'SUGGESTION',
      verification: { refuted: false, votes: 1, refutals: 0, reasons: [], adjustedSeverity: null, adjustedConfidence: null },
    });
    const outcome = applyPolicy(config, registry, [finding]);
    assert.equal(finding.verdict, 'REQUEST_CHANGE');
    assert.equal(outcome.event, 'REQUEST_CHANGES');
    assert.ok(outcome.notes.some((note) => note.includes('안전 게이트')));
  });

  it('does not escalate an unverified gate finding', () => {
    const finding = makeFinding({
      owner: 'security',
      severity: 'blocker',
      confidence: 0.95,
      verdict: 'SUGGESTION',
      verification: null,
    });
    applyPolicy(config, registry, [finding]);
    assert.equal(finding.verdict, 'SUGGESTION');
  });

  it('does not escalate a low-confidence gate finding', () => {
    const finding = makeFinding({
      owner: 'consistency',
      severity: 'high',
      confidence: 0.55,
      verdict: 'SUGGESTION',
      verification: { refuted: false, votes: 1, refutals: 0, reasons: [], adjustedSeverity: null, adjustedConfidence: null },
    });
    applyPolicy(config, registry, [finding]);
    assert.equal(finding.verdict, 'SUGGESTION');
  });

  it('never lets a value persona block the merge', () => {
    const finding = makeFinding({ owner: 'architect', severity: 'blocker', confidence: 0.99, verdict: 'REQUEST_CHANGE' });
    const outcome = applyPolicy(config, registry, [finding]);
    assert.equal(finding.verdict, 'SUGGESTION');
    assert.equal(outcome.event, 'COMMENT');
    assert.ok(outcome.notes.some((note) => note.includes('차단 권한이 없어')));
  });

  it('downgrades a performance block that states no scale', () => {
    const finding = makeFinding({
      owner: 'performance',
      verdict: 'REQUEST_CHANGE',
      evidence: '느립니다',
      scenario: '',
    });
    applyPolicy(config, registry, [finding]);
    assert.equal(finding.verdict, 'SUGGESTION');
  });

  it('keeps a performance block that states a measured scale', () => {
    const finding = makeFinding({
      owner: 'performance',
      verdict: 'REQUEST_CHANGE',
      evidence: 'src/repo.ts:42 루프 안에서 findOne 호출',
      scenario: '주문 500건 조회 시 쿼리가 1회에서 501회로 증가한다',
    });
    const outcome = applyPolicy(config, registry, [finding]);
    assert.equal(finding.verdict, 'REQUEST_CHANGE');
    assert.equal(outcome.event, 'REQUEST_CHANGES');
  });
});

describe('applyPolicy — filtering and caps', () => {
  it('drops refuted and DROP-verdict findings', () => {
    const refuted = makeFinding({
      verification: { refuted: true, votes: 1, refutals: 1, reasons: ['이미 처리됨'], adjustedSeverity: null, adjustedConfidence: null },
    });
    const dropped = makeFinding({ verdict: 'DROP' });
    const outcome = applyPolicy(config, registry, [refuted, dropped]);
    assert.equal(outcome.inline.length, 0);
    assert.equal(outcome.dropped.length, 2);
  });

  it('drops findings below the confidence floor', () => {
    const outcome = applyPolicy(config, registry, [makeFinding({ confidence: 0.2 })]);
    assert.equal(outcome.dropped.length, 1);
  });

  it('routes unanchored findings to the summary', () => {
    const outcome = applyPolicy(config, registry, [makeFinding({ anchor: null })]);
    assert.equal(outcome.inline.length, 0);
    assert.equal(outcome.summaryOnly.length, 1);
    assert.ok(outcome.notes.some((note) => note.includes('앵커할 수 없어')));
  });

  it('enforces the per-agent inline cap', () => {
    const capped = testConfig({ policy: { ...config.policy, maxInlinePerAgent: 2, maxInlineTotal: 100 } });
    const findings = Array.from({ length: 5 }, () => makeFinding({ owner: 'architect' }));
    const outcome = applyPolicy(capped, registry, findings);
    assert.equal(outcome.inline.length, 2);
    assert.equal(outcome.summaryOnly.length, 3);
  });

  it('enforces the total inline cap across agents', () => {
    const capped = testConfig({ policy: { ...config.policy, maxInlinePerAgent: 10, maxInlineTotal: 3 } });
    const findings = [
      ...Array.from({ length: 3 }, () => makeFinding({ owner: 'architect' })),
      ...Array.from({ length: 3 }, () => makeFinding({ owner: 'collaborator' })),
    ];
    const outcome = applyPolicy(capped, registry, findings);
    assert.equal(outcome.inline.length, 3);
    assert.equal(outcome.summaryOnly.length, 3);
  });

  it('orders blocking findings ahead of suggestions', () => {
    const suggestion = makeFinding({ owner: 'architect', verdict: 'SUGGESTION', severity: 'low' });
    const blocker = makeFinding({
      owner: 'security',
      severity: 'blocker',
      confidence: 0.95,
      verdict: 'REQUEST_CHANGE',
      verification: { refuted: false, votes: 1, refutals: 0, reasons: [], adjustedSeverity: null, adjustedConfidence: null },
    });
    const outcome = applyPolicy(config, registry, [suggestion, blocker]);
    assert.equal(outcome.inline[0]?.id, blocker.id);
  });

  it('approves a clean PR only when configured to', () => {
    assert.equal(applyPolicy(config, registry, []).event, 'COMMENT');
    const approving = testConfig({ publish: { ...config.publish, approveWhenClean: true } });
    assert.equal(applyPolicy(approving, registry, []).event, 'APPROVE');
  });

  it('honours publish.event=comment as a hard override', () => {
    const commentOnly = testConfig({ publish: { ...config.publish, event: 'comment' } });
    const blocker = makeFinding({
      owner: 'security',
      severity: 'blocker',
      confidence: 0.95,
      verdict: 'REQUEST_CHANGE',
      verification: { refuted: false, votes: 1, refutals: 0, reasons: [], adjustedSeverity: null, adjustedConfidence: null },
    });
    assert.equal(applyPolicy(commentOnly, registry, [blocker]).event, 'COMMENT');
  });
});

describe('hasScaleEvidence', () => {
  it('requires both a number and enough detail', () => {
    assert.equal(hasScaleEvidence(makeFinding({ evidence: '3', scenario: '' })), false);
    assert.equal(
      hasScaleEvidence(makeFinding({ evidence: '레코드 10만 건에서 응답이 1.2초로 증가한다', scenario: '피크 트래픽' })),
      true,
    );
  });
});
