import { SEVERITY_RANK, VERDICT_RANK } from "../types.js";
/**
 * The deterministic gate.
 *
 * Everything upstream is a language model, so the merge-blocking decision itself
 * is made here by fixed rules: safety gates can escalate, value personas can never
 * block, and a performance claim without a stated scale cannot block either.
 */
export function applyPolicy(config, registry, findings) {
    const notes = [];
    const kept = [];
    const dropped = [];
    for (const finding of findings) {
        const klass = registry.get(finding.owner)?.klass ?? 'value';
        if (finding.verdict === 'DROP') {
            dropped.push(finding);
            continue;
        }
        if (finding.verification?.refuted) {
            dropped.push(finding);
            notes.push(`${finding.id} 반박되어 제외됨`);
            continue;
        }
        if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[config.policy.dropBelowSeverity]) {
            dropped.push(finding);
            continue;
        }
        if (finding.confidence < config.policy.dropBelowConfidence) {
            dropped.push(finding);
            notes.push(`${finding.id} 확신도 ${finding.confidence.toFixed(2)} 미만으로 제외됨`);
            continue;
        }
        const verdict = finding.verdict ?? 'SUGGESTION';
        const adjusted = clampVerdict(config, klass, finding, verdict, notes);
        finding.verdict = adjusted;
        kept.push(finding);
    }
    kept.sort((a, b) => {
        const verdictDelta = VERDICT_RANK[b.verdict ?? 'SUGGESTION'] - VERDICT_RANK[a.verdict ?? 'SUGGESTION'];
        if (verdictDelta !== 0)
            return verdictDelta;
        const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (severityDelta !== 0)
            return severityDelta;
        if (b.confidence !== a.confidence)
            return b.confidence - a.confidence;
        return a.file.localeCompare(b.file) || a.start_line - b.start_line;
    });
    const inline = [];
    const summaryOnly = [];
    const perAgent = new Map();
    for (const finding of kept) {
        if (!finding.anchor) {
            summaryOnly.push(finding);
            continue;
        }
        // Minor notes stay in the review, just not line by line in the diff.
        if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[config.policy.inlineMinSeverity]) {
            summaryOnly.push(finding);
            continue;
        }
        if (inline.length >= config.policy.maxInlineTotal) {
            summaryOnly.push(finding);
            continue;
        }
        const used = perAgent.get(finding.owner) ?? 0;
        if (used >= config.policy.maxInlinePerAgent) {
            summaryOnly.push(finding);
            continue;
        }
        perAgent.set(finding.owner, used + 1);
        inline.push(finding);
    }
    const unanchored = summaryOnly.filter((finding) => !finding.anchor).length;
    if (unanchored > 0)
        notes.push(`diff에 앵커할 수 없어 ${unanchored}건은 요약으로 이동`);
    const minor = summaryOnly.filter((finding) => finding.anchor && SEVERITY_RANK[finding.severity] < SEVERITY_RANK[config.policy.inlineMinSeverity]).length;
    if (minor > 0)
        notes.push(`심각도가 \`${config.policy.inlineMinSeverity}\` 미만이라 ${minor}건은 요약으로 이동`);
    const overflow = summaryOnly.length - unanchored - minor;
    if (overflow > 0)
        notes.push(`인라인 코멘트 상한을 넘어 ${overflow}건은 요약으로 이동`);
    const blocking = kept.filter((finding) => finding.verdict === 'REQUEST_CHANGE');
    const event = resolveEvent(config, blocking.length, kept.length);
    return { inline, summaryOnly, dropped, blocking, event, notes };
}
function clampVerdict(config, klass, finding, verdict, notes) {
    // Safety gates: a proven, high-confidence defect blocks regardless of the
    // mediator's cost trade-off. This is the whole point of a gate.
    if (klass === 'gate') {
        const severeEnough = SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[config.policy.blockMinSeverity];
        const confidentEnough = finding.confidence >= config.policy.blockMinConfidence;
        const verified = finding.verification ? !finding.verification.refuted && finding.verification.votes > 0 : false;
        if (severeEnough && confidentEnough && verified && verdict !== 'REQUEST_CHANGE' && verdict !== 'QUESTION') {
            notes.push(`${finding.id} 안전 게이트(${finding.owner}) 기준 충족 → REQUEST_CHANGE로 상향`);
            return 'REQUEST_CHANGE';
        }
        return verdict;
    }
    // Analysts may block, but only with a stated scale or measurement.
    if (klass === 'analyst') {
        if (verdict === 'REQUEST_CHANGE' && config.policy.requireAnalystEvidence && !hasScaleEvidence(finding)) {
            notes.push(`${finding.id} 규모/측정 근거가 없어 REQUEST_CHANGE → SUGGESTION으로 하향`);
            return 'SUGGESTION';
        }
        return verdict;
    }
    // Value personas negotiate; they never block a merge on their own.
    if (verdict === 'REQUEST_CHANGE') {
        notes.push(`${finding.id} 가치 에이전트(${finding.owner})는 차단 권한이 없어 SUGGESTION으로 하향`);
        return 'SUGGESTION';
    }
    return verdict;
}
/** A performance claim needs a number: a scale, a count, a duration or a measurement. */
export function hasScaleEvidence(finding) {
    const text = `${finding.evidence} ${finding.scenario}`.trim();
    // A bare number ("3") is not evidence; it has to sit in a described condition.
    return /\d/.test(text) && text.length >= 25;
}
function resolveEvent(config, blockingCount, keptCount) {
    if (config.publish.event === 'comment')
        return 'COMMENT';
    if (config.publish.event === 'request_changes')
        return blockingCount > 0 ? 'REQUEST_CHANGES' : 'COMMENT';
    if (blockingCount > 0)
        return 'REQUEST_CHANGES';
    if (keptCount === 0 && config.publish.approveWhenClean)
        return 'APPROVE';
    return 'COMMENT';
}
//# sourceMappingURL=policy.js.map