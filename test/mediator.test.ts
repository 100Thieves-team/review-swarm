import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeSummary } from '../src/pipeline/mediator.ts';

describe('sanitizeSummary', () => {
  it('strips a stray closing tag echoed from the input', () => {
    // Observed in a real run: the model ended its summary with </summary>,
    // which swallowed the rest of the posted review body.
    const summary = sanitizeSummary('teamRuleFiles를 고치는 것을 권장합니다.</summary>');
    assert.equal(summary, 'teamRuleFiles를 고치는 것을 권장합니다.');
  });

  it('strips details/summary wrappers in any casing or with attributes', () => {
    assert.equal(sanitizeSummary('<DETAILS open><Summary>제목</Summary>본문</details>'), '제목본문');
  });

  it('leaves ordinary prose and inline code untouched', () => {
    const prose = '`teamRuleFiles`를 `docs/conventions/README.md`로 바꾸세요. <- 화살표도 유지된다';
    assert.equal(sanitizeSummary(prose), prose);
  });

  it('collapses the blank lines a removed block leaves behind', () => {
    assert.equal(sanitizeSummary('첫 문단\n\n\n\n둘째 문단'), '첫 문단\n\n둘째 문단');
  });
});
