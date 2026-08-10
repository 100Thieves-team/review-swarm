import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canUseSuggestion, findingMarker, parseFingerprint, renderFindingBody } from '../src/publish/render.ts';
import { makeFinding, testRegistry } from './helpers.ts';

const registry = testRegistry();

describe('renderFindingBody', () => {
  it('embeds a machine-readable fingerprint that round-trips', () => {
    const finding = makeFinding({ owner: 'security', fingerprint: 'abc123def0' });
    const body = renderFindingBody(finding, registry.get('security'), { includeAgentHeader: false });
    assert.ok(body.includes(findingMarker(finding)));
    assert.equal(parseFingerprint(body), 'abc123def0');
  });

  it('names the persona only when a shared identity posts', () => {
    const finding = makeFinding({ owner: 'security' });
    const withHeader = renderFindingBody(finding, registry.get('security'), { includeAgentHeader: true });
    const withoutHeader = renderFindingBody(finding, registry.get('security'), { includeAgentHeader: false });
    assert.ok(withHeader.includes('Security Sentinel'));
    assert.equal(withoutHeader.includes('Security Sentinel'), false);
  });

  it('shows the verdict badge and severity', () => {
    const body = renderFindingBody(
      makeFinding({ verdict: 'REQUEST_CHANGE', severity: 'high' }),
      registry.get('architect'),
      { includeAgentHeader: true },
    );
    assert.ok(body.includes('필수 수정'));
    assert.ok(body.includes('severity `high`'));
  });

  it('prefers the mediator-merged body over the raw fields', () => {
    const body = renderFindingBody(
      makeFinding({ mergedBody: '통합된 설명', rationale: '원래 설명' }),
      registry.get('architect'),
      { includeAgentHeader: true },
    );
    assert.ok(body.includes('통합된 설명'));
    assert.equal(body.includes('원래 설명'), false);
  });

  it('records that a comment was moved to a nearby diff line', () => {
    const body = renderFindingBody(
      makeFinding({
        start_line: 20,
        end_line: 20,
        anchor: { path: 'src/app.ts', line: 13, side: 'RIGHT', startLine: null, startSide: null, snappedBy: 7 },
      }),
      registry.get('architect'),
      { includeAgentHeader: true },
    );
    assert.ok(body.includes('7줄 이동'));
  });
});

describe('canUseSuggestion', () => {
  it('accepts an exact single-line anchor', () => {
    const finding = makeFinding({
      start_line: 10,
      end_line: 10,
      anchor: { path: 'src/app.ts', line: 10, side: 'RIGHT', startLine: null, startSide: null, snappedBy: 0 },
    });
    assert.equal(canUseSuggestion(finding), true);
  });

  it('accepts an exact multi-line anchor', () => {
    const finding = makeFinding({
      start_line: 10,
      end_line: 12,
      anchor: { path: 'src/app.ts', line: 12, side: 'RIGHT', startLine: 10, startSide: 'RIGHT', snappedBy: 0 },
    });
    assert.equal(canUseSuggestion(finding), true);
  });

  it('refuses when the comment was snapped to another line', () => {
    const finding = makeFinding({
      start_line: 10,
      end_line: 10,
      anchor: { path: 'src/app.ts', line: 13, side: 'RIGHT', startLine: null, startSide: null, snappedBy: 3 },
    });
    assert.equal(canUseSuggestion(finding), false);
  });

  it('refuses when the anchored range is narrower than the finding', () => {
    const finding = makeFinding({
      start_line: 10,
      end_line: 12,
      anchor: { path: 'src/app.ts', line: 12, side: 'RIGHT', startLine: null, startSide: null, snappedBy: 0 },
    });
    assert.equal(canUseSuggestion(finding), false);
  });

  it('refuses on the LEFT side, where a suggestion cannot apply', () => {
    const finding = makeFinding({
      start_line: 10,
      end_line: 10,
      anchor: { path: 'src/app.ts', line: 10, side: 'LEFT', startLine: null, startSide: null, snappedBy: 0 },
    });
    assert.equal(canUseSuggestion(finding), false);
  });

  it('renders an inapplicable patch as a plain block, not a suggestion', () => {
    const finding = makeFinding({
      suggestion_patch: 'const x = 1;',
      start_line: 10,
      end_line: 10,
      anchor: { path: 'src/app.ts', line: 13, side: 'RIGHT', startLine: null, startSide: null, snappedBy: 3 },
    });
    const body = renderFindingBody(finding, registry.get('architect'), { includeAgentHeader: true });
    assert.equal(body.includes('```suggestion'), false);
    assert.ok(body.includes('const x = 1;'));
  });
});
