import { HARNESS_RULES } from "../agents/personas.js";
import { persist } from "../context/blackboard.js";
import { MEDIATOR_SCHEMA, VERDICTS } from "../types.js";
import { asArray, asEnum, asRecord, asString } from "../util/json.js";
import { truncate } from "../util/text.js";
/**
 * The mediator judges — it does not investigate.
 *
 * It sees only what the experts already produced, so it cannot invent a new
 * problem at the last stage where nothing verifies it.
 */
export async function mediate(options) {
    const { config, pool, registry, context, findings, logger } = options;
    if (findings.length === 0) {
        return { summary: '차단할 문제가 발견되지 않았습니다.', ok: true, error: null };
    }
    if (!config.mediator.enabled) {
        applyFallbackVerdicts(findings, registry, config);
        return { summary: '조정자 비활성화 — 정책 게이트만 적용했습니다.', ok: true, error: null };
    }
    const mediator = registry.get('mediator');
    const prompt = buildMediatorPrompt(mediator?.persona ?? '', findings, registry, context, options.prior);
    persist(context.runDir, 'prompts/mediator.md', prompt);
    // Engine settings for this stage may be written under either `mediator:` or
    // `agents.mediator:`. Honour both so neither is a silent no-op; `mediator:` wins.
    const { engine, model, effort, timeoutMs } = pool.resolve({
        ...config.agents['mediator'],
        ...stripUndefined(config.mediator),
    });
    const response = await engine.invoke({
        label: 'mediator',
        prompt,
        schema: MEDIATOR_SCHEMA,
        cwd: context.workdir,
        runDir: context.runDir,
        timeoutMs,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
    });
    if (!response.ok) {
        logger.warn(`mediator failed: ${response.error}; falling back to severity-based verdicts`);
        applyFallbackVerdicts(findings, registry, config);
        return { summary: '조정자 실행에 실패해 심각도 기반 기본 판정을 적용했습니다.', ok: false, error: response.error };
    }
    const record = asRecord(response.data) ?? {};
    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    let decided = 0;
    for (const entry of asArray(record['decisions'])) {
        const decision = asRecord(entry);
        if (!decision)
            continue;
        const finding = byId.get(asString(decision['id']).trim());
        // Ignore ids the mediator invented; only the given findings may be judged.
        if (!finding)
            continue;
        finding.verdict = asEnum(decision['verdict'], VERDICTS, 'SUGGESTION');
        finding.verdictReason = asString(decision['reason']).trim() || null;
        const merged = asString(decision['merged_body']).trim();
        finding.mergedBody = merged || null;
        decided += 1;
    }
    // Anything the mediator skipped still needs a defensible verdict.
    const undecided = findings.filter((finding) => finding.verdict === null);
    if (undecided.length > 0) {
        applyFallbackVerdicts(undecided, registry, config);
        logger.warn(`mediator skipped ${undecided.length} findings; applied fallback verdicts`);
    }
    logger.info(`mediator: ${decided}/${findings.length} findings judged`);
    persist(context.runDir, 'mediation.json', findings.map((f) => ({ id: f.id, verdict: f.verdict, reason: f.verdictReason })));
    return { summary: sanitizeSummary(asString(record['summary'])) || '조정자 요약 없음.', ok: true, error: null };
}
/**
 * The summary is pasted straight into a review body, so a stray `</summary>` or
 * `<details>` the model echoed from its input would unbalance the surrounding
 * markdown and swallow the rest of the comment. It is meant to be plain prose.
 */
export function sanitizeSummary(summary) {
    return summary
        .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function stripUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
/**
 * Prior review state, rendered for the judge.
 *
 * Fingerprint equality cannot catch a rephrased duplicate — measured on real runs,
 * three comments describing the same concern shared almost no wording. A judge
 * that can read both can; that is why this lands here and not in a string matcher.
 */
function renderPrior(prior) {
    if (prior.length === 0)
        return '';
    const dismissed = prior.filter((entry) => entry.dismissed);
    const standing = prior.filter((entry) => !entry.dismissed);
    const lines = ['## 이 PR에 이미 게시된 리뷰 (같은 문제를 다시 올리지 마라)'];
    if (standing.length > 0) {
        lines.push('\n### 아직 열려 있는 지적');
        for (const entry of standing) {
            lines.push(`- \`${entry.agent}\` ${entry.path ?? '?'}${entry.line ? `:${entry.line}` : ''} — ${entry.title}${entry.outdated ? ' (해당 라인은 이후 커밋에서 바뀜)' : ''}`);
        }
    }
    if (dismissed.length > 0) {
        lines.push('\n### 작성자가 닫은 지적 (스레드 resolve 또는 👎)');
        for (const entry of dismissed) {
            lines.push(`- \`${entry.agent}\` ${entry.path ?? '?'} — ${entry.title}`);
        }
    }
    lines.push(`
판정 규칙:
- 위 목록 중 **어떤 항목과 같은 문제**를 이번 finding이 다시 제기하고 있다면, 표현이 달라도 DROP하라.
  제목이 달라도, 분류가 달라도, 지적 위치가 달라도 마찬가지다. 문제의 실체가 같은지로 판단하라.
- **작성자가 닫은 지적**은 반영하지 않기로 한 결정이다. 같은 문제를 다시 올리는 것은 무조건 DROP이다.
  더 심각한 새 근거가 생겼더라도 이번 PR에서는 다시 제기하지 마라.
- 이전 지적을 실제로 **고친 결과** 새로 생긴 문제는 새 문제다. 그건 DROP하지 마라.`);
    return `${lines.join('\n')}\n\n---\n\n`;
}
function buildMediatorPrompt(persona, findings, registry, context, prior) {
    const rendered = findings
        .map((finding) => {
        const agent = registry.get(finding.owner);
        const lines = [
            `### ${finding.id}`,
            `- 작성자: \`${finding.owner}\` (${agent?.klass ?? 'value'}${finding.agents.length > 1 ? `, 동의: ${finding.agents.filter((id) => id !== finding.owner).join(', ')}` : ''})`,
            `- 위치: \`${finding.file}\`:${finding.anchor?.line ?? finding.start_line}${finding.anchor ? '' : ' (인라인 앵커 실패 — 요약에만 표시됨)'}`,
            `- 심각도: \`${finding.severity}\` / 확신도: ${finding.confidence.toFixed(2)} / 분류: \`${finding.category}\``,
            `- 제목: ${finding.title}`,
            `- 근거: ${truncate(finding.evidence || '(없음)', 600)}`,
            `- 시나리오: ${truncate(finding.scenario || '(없음)', 600)}`,
            `- 제안: ${truncate(finding.suggested_fix || '(없음)', 600)}`,
        ];
        if (finding.verification) {
            const v = finding.verification;
            lines.push(`- 검증: ${v.votes}표 중 ${v.refutals}표 반박${v.reasons[0] ? ` — ${truncate(v.reasons[0], 400)}` : ''}`);
        }
        if (finding.debate) {
            lines.push(`- 토론 (상대: \`${finding.debate.opponentAgent}\`):`);
            for (const position of finding.debate.positions) {
                lines.push(`  - \`${position.agent}\`: ${truncate(position.position, 400)}` +
                    (position.concession ? ` / 인정: ${truncate(position.concession, 200)}` : '') +
                    (position.counterProposal ? ` / 절충안: ${truncate(position.counterProposal, 300)}` : ''));
            }
        }
        return lines.join('\n');
    })
        .join('\n\n');
    return `${persona}

---

${HARNESS_RULES}

---

# 조정 대상

저장소 \`${context.pr.owner}/${context.pr.repo}\` PR #${context.pr.number} — "${context.pr.title}"
변경 파일 ${context.changedFiles.length}개.

${renderPrior(prior)}아래는 전문 에이전트들이 제출하고 검증을 통과한 finding 목록이다. **이 목록에 있는 id만 판정하라.**

${rendered}

## 판정 규칙 (하네스가 강제한다)

- 안전 게이트(\`security\`, \`consistency\`)의 입증된 심각한 문제는 생산성을 이유로 기각하지 마라.
- \`performance\`는 데이터 규모나 트래픽 조건 같은 구체적 근거가 있을 때만 강하게 다뤄라. 근거가 없으면 SUGGESTION 이하다.
- 가치 에이전트(\`architect\`, \`pragmatist\`, \`collaborator\`)는 서로 절충 대상이다. 이들만으로는 PR을 막지 마라.
- 같은 문제가 여러 건으로 남아 있으면 하나만 남기고 나머지는 DROP하며, 남긴 항목의 \`merged_body\`에 통합 내용을 써라.
- 취향, 근거 부족, 추상적 우려는 DROP.
- 각 finding에 정확히 하나의 판정을 내려라. 목록에 없는 id를 만들지 마라.

\`merged_body\`는 병합하거나 문구를 다듬은 경우에만 채우고, 그 외에는 null로 둬라. 채울 때는 한국어 마크다운으로 작성하라.
\`summary\`는 PR 작성자가 읽을 2~5문장 한국어 요약이다.

JSON 하나만 출력하라.`;
}
/** Severity-driven verdicts used when the mediator is off or failed. */
function applyFallbackVerdicts(findings, registry, config) {
    for (const finding of findings) {
        const klass = registry.get(finding.owner)?.klass ?? 'value';
        if (klass === 'gate' && (finding.severity === 'blocker' || finding.severity === 'high')) {
            finding.verdict = 'REQUEST_CHANGE';
        }
        else if (finding.severity === 'low' || finding.severity === 'info') {
            finding.verdict = 'FOLLOW_UP';
        }
        else {
            finding.verdict = 'SUGGESTION';
        }
        finding.verdictReason ??= `조정자 미실행 — ${config.publish.language === 'ko' ? '심각도 기반 기본 판정' : 'severity-based default'}`;
    }
}
//# sourceMappingURL=mediator.js.map