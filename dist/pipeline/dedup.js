import { DEFAULT_ANCHOR_OPTIONS, resolveAnchor } from "../context/diff.js";
import { SEVERITY_RANK } from "../types.js";
import { normalizeText, shortId, similarity } from "../util/text.js";
const CLASS_AUTHORITY = {
    gate: 3,
    analyst: 2,
    value: 1,
    mediator: 0,
};
/**
 * Turn per-agent findings into one anchored, de-duplicated list.
 *
 * Two personas describing the same defect must become one comment — otherwise the
 * author reads the same problem three times and stops reading.
 */
export function dedupeFindings(options) {
    const { config, registry, parsed, results } = options;
    const anchorOptions = { ...DEFAULT_ANCHOR_OPTIONS, maxSnapDistance: config.policy.maxSnapDistance };
    const findings = [];
    for (const result of results) {
        for (const raw of result.findings) {
            const anchor = resolveAnchor(parsed, raw.file, raw.start_line, raw.end_line, raw.side, anchorOptions);
            findings.push({
                ...raw,
                // Anchoring may have corrected a suffix-shortened path.
                file: anchor?.path ?? raw.file,
                id: '',
                agents: [result.agentId],
                owner: result.agentId,
                fingerprint: '',
                anchor,
                verification: null,
                debate: null,
                verdict: null,
                verdictReason: null,
                mergedBody: null,
            });
        }
    }
    const merged = [];
    for (const finding of findings) {
        const target = merged.find((candidate) => isSameIssue(candidate, finding));
        if (target)
            mergeInto(target, finding, registry);
        else
            merged.push(finding);
    }
    merged.sort((a, b) => {
        const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (severityDelta !== 0)
            return severityDelta;
        const authorityDelta = authority(registry, b.owner) - authority(registry, a.owner);
        if (authorityDelta !== 0)
            return authorityDelta;
        if (b.confidence !== a.confidence)
            return b.confidence - a.confidence;
        return a.file.localeCompare(b.file) || a.start_line - b.start_line;
    });
    merged.forEach((finding, index) => {
        finding.id = `F${index + 1}`;
        finding.fingerprint = shortId(finding.owner, finding.file, finding.category, normalizeText(finding.title));
    });
    return merged;
}
function isSameIssue(a, b) {
    if (a.file !== b.file)
        return false;
    const lineA = a.anchor?.line ?? a.start_line;
    const lineB = b.anchor?.line ?? b.start_line;
    const overlaps = Math.abs(lineA - lineB) <= 3 || rangesOverlap(a, b);
    if (!overlaps)
        return false;
    if (a.category === b.category)
        return true;
    return similarity(`${a.title} ${a.suggested_fix}`, `${b.title} ${b.suggested_fix}`) >= 0.55;
}
function rangesOverlap(a, b) {
    return a.start_line <= b.end_line && b.start_line <= a.end_line;
}
function mergeInto(target, incoming, registry) {
    for (const agentId of incoming.agents) {
        if (!target.agents.includes(agentId))
            target.agents.push(agentId);
    }
    // Ownership follows authority: a gate persona must keep the blocking power.
    if (authority(registry, incoming.owner) > authority(registry, target.owner)) {
        target.owner = incoming.owner;
        target.category = incoming.category;
        target.title = incoming.title;
    }
    if (SEVERITY_RANK[incoming.severity] > SEVERITY_RANK[target.severity])
        target.severity = incoming.severity;
    // Independent agreement is evidence; nudge confidence up without ever reaching certainty.
    target.confidence = Math.min(0.99, Math.max(target.confidence, incoming.confidence) + 0.05);
    target.rationale = pickRicher(target.rationale, incoming.rationale);
    target.evidence = pickRicher(target.evidence, incoming.evidence);
    target.scenario = pickRicher(target.scenario, incoming.scenario);
    target.suggested_fix = pickRicher(target.suggested_fix, incoming.suggested_fix);
    target.suggestion_patch ??= incoming.suggestion_patch;
    if (!target.anchor && incoming.anchor)
        target.anchor = incoming.anchor;
    target.start_line = Math.min(target.start_line, incoming.start_line);
    target.end_line = Math.max(target.end_line, incoming.end_line);
}
function pickRicher(current, incoming) {
    return incoming.length > current.length ? incoming : current;
}
function authority(registry, agentId) {
    return CLASS_AUTHORITY[registry.get(agentId)?.klass ?? 'value'];
}
//# sourceMappingURL=dedup.js.map