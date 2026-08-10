import type { AgentDefinition } from '../agents/registry.ts';
import type { SwarmConfig } from '../config.ts';
import type { RoutingDecision } from '../pipeline/router.ts';
import type { PolicyOutcome } from '../pipeline/policy.ts';
import type { ExpertResult, Finding, ReviewContext, Verdict } from '../types.ts';
import { fence, truncate } from '../util/text.ts';

export const MARKER_PREFIX = 'review-swarm:v1';

export function findingMarker(finding: Finding): string {
  return `<!-- ${MARKER_PREFIX} agent=${finding.owner} fp=${finding.fingerprint} -->`;
}

export function summaryMarker(): string {
  return `<!-- ${MARKER_PREFIX} summary -->`;
}

/** Pull the fingerprint back out of an existing comment so reruns can skip it. */
export function parseFingerprint(body: string): string | null {
  const match = new RegExp(`<!--\\s*${MARKER_PREFIX}\\s+agent=([\\w-]+)\\s+fp=([0-9a-f]+)\\s*-->`).exec(body);
  return match?.[2] ?? null;
}

const VERDICT_BADGE: Record<Verdict, string> = {
  REQUEST_CHANGE: '🔴 필수 수정',
  SUGGESTION: '🟡 제안',
  FOLLOW_UP: '🔵 후속 작업',
  QUESTION: '❓ 확인 필요',
  DROP: '⚪ 폐기',
};

export interface RenderOptions {
  /** With a single bot identity every comment must name its persona itself. */
  includeAgentHeader: boolean;
}

export function renderFindingBody(
  finding: Finding,
  agent: AgentDefinition | undefined,
  options: RenderOptions,
): string {
  const verdict = finding.verdict ?? 'SUGGESTION';
  const parts: string[] = [];

  const header = [
    options.includeAgentHeader ? `${agent?.emoji ?? '🔎'} **${agent?.displayName ?? finding.owner}**` : null,
    VERDICT_BADGE[verdict],
    `\`${finding.category}\``,
    `severity \`${finding.severity}\``,
    `확신도 ${finding.confidence.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(' · ');

  parts.push(header);
  parts.push(`### ${finding.title}`);

  if (finding.mergedBody) {
    parts.push(finding.mergedBody);
  } else {
    if (finding.rationale) parts.push(finding.rationale);
    if (finding.scenario) parts.push(`**시나리오**\n${finding.scenario}`);
    if (finding.evidence) parts.push(`**근거**\n${finding.evidence}`);
    if (finding.suggested_fix) parts.push(`**제안**\n${finding.suggested_fix}`);
  }

  if (finding.suggestion_patch) {
    parts.push(
      canUseSuggestion(finding)
        ? fence(finding.suggestion_patch, 'suggestion')
        : `<details><summary>제안 코드 (라인 범위가 정확히 일치하지 않아 suggestion으로 적용되지 않습니다)</summary>\n\n${fence(finding.suggestion_patch)}\n\n</details>`,
    );
  }

  const meta: string[] = [];
  if (finding.agents.length > 1) {
    meta.push(`동의한 에이전트: ${finding.agents.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (finding.verdictReason) meta.push(`조정자: ${finding.verdictReason}`);
  if (finding.verification) {
    const v = finding.verification;
    meta.push(
      v.votes === 0
        ? '검증: 실행 실패 (미검증)'
        : `검증: ${v.votes}표 중 ${v.refutals}표 반박${v.reasons[0] ? ` — ${truncate(v.reasons[0], 300)}` : ''}`,
    );
  }
  if (finding.debate) {
    const positions = finding.debate.positions
      .map((position) => `- \`${position.agent}\`: ${truncate(position.position, 300)}${position.counterProposal ? `\n  - 절충안: ${truncate(position.counterProposal, 300)}` : ''}`)
      .join('\n');
    meta.push(`<details><summary>토론 기록 (상대: \`${finding.debate.opponentAgent}\`)</summary>\n\n${positions}\n\n</details>`);
  }
  if (finding.anchor && finding.anchor.snappedBy > 0) {
    meta.push(`원 지적 위치: \`${finding.file}:${finding.start_line}\` (diff 라인으로 ${finding.anchor.snappedBy}줄 이동)`);
  }

  if (meta.length > 0) parts.push(`<sub>${meta.join('<br>')}</sub>`);
  parts.push(findingMarker(finding));

  return parts.join('\n\n');
}

/** A GitHub suggestion replaces exactly the commented lines — only offer one when they match. */
export function canUseSuggestion(finding: Finding): boolean {
  const anchor = finding.anchor;
  if (!anchor || anchor.side !== 'RIGHT' || anchor.snappedBy !== 0) return false;
  if (anchor.line !== finding.end_line) return false;
  if (finding.start_line === finding.end_line) return anchor.startLine === null;
  return anchor.startLine === finding.start_line;
}

export interface SummaryInput {
  config: SwarmConfig;
  context: ReviewContext;
  registry: Map<string, AgentDefinition>;
  routing: RoutingDecision;
  results: ExpertResult[];
  outcome: PolicyOutcome;
  mediatorSummary: string;
  skipped: Finding[];
  durationMs: number;
  degraded: string[];
}

export function renderSummary(input: SummaryInput): string {
  const { context, registry, routing, results, outcome, mediatorSummary, skipped, durationMs, degraded } = input;
  const total = outcome.inline.length + outcome.summaryOnly.length;

  const counts = new Map<Verdict, number>();
  for (const finding of [...outcome.inline, ...outcome.summaryOnly]) {
    const verdict = finding.verdict ?? 'SUGGESTION';
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }

  const parts: string[] = [];

  parts.push(`## ⚖️ Multi-Agent Review — ${outcome.event === 'REQUEST_CHANGES' ? '🔴 수정 요청' : outcome.event === 'APPROVE' ? '🟢 승인' : '🟡 코멘트'}`);
  parts.push(mediatorSummary);

  parts.push(`| 판정 | 건수 |
| --- | --- |
${(['REQUEST_CHANGE', 'SUGGESTION', 'FOLLOW_UP', 'QUESTION'] as Verdict[])
  .map((verdict) => `| ${VERDICT_BADGE[verdict]} | ${counts.get(verdict) ?? 0} |`)
  .join('\n')}
| 합계 | ${total} |`);

  const agentRows = results
    .map((result) => {
      const agent = registry.get(result.agentId);
      const why = routing.reasons.get(result.agentId)?.join(', ') ?? '-';
      const status = result.ok ? '✅' : '❌';
      const kept = [...outcome.inline, ...outcome.summaryOnly].filter((finding) =>
        finding.agents.includes(result.agentId),
      ).length;
      return `| ${agent?.emoji ?? '🔎'} ${agent?.displayName ?? result.agentId} | ${status} | ${result.findings.length} → ${kept} | ${Math.round(result.durationMs / 1000)}s | ${why} |`;
    })
    .join('\n');

  parts.push(`<details><summary>실행된 에이전트 (${results.length}) · ${Math.round(durationMs / 1000)}s</summary>

| 에이전트 | 상태 | 제출 → 채택 | 소요 | 선택 이유 |
| --- | --- | --- | --- | --- |
${agentRows}

${routing.fullSweep ? '전체 스윕 모드로 실행되었습니다 (대형 변경).' : ''}
</details>`);

  if (outcome.summaryOnly.length > 0) {
    const rendered = outcome.summaryOnly
      .map((finding) => {
        const agent = registry.get(finding.owner);
        return `<details><summary>${VERDICT_BADGE[finding.verdict ?? 'SUGGESTION']} · ${agent?.emoji ?? '🔎'} <code>${finding.file}:${finding.start_line}</code> — ${escapeHtml(finding.title)}</summary>

${renderFindingBody(finding, agent, { includeAgentHeader: true })}

</details>`;
      })
      .join('\n\n');
    parts.push(`### 인라인으로 달리지 않은 항목 (${outcome.summaryOnly.length})\n\n${rendered}`);
  }

  if (skipped.length > 0) {
    parts.push(
      `<details><summary>이전 리뷰에서 이미 지적한 항목 (${skipped.length})</summary>\n\n${skipped
        .map((finding) => `- \`${finding.file}:${finding.anchor?.line ?? finding.start_line}\` — ${escapeHtml(finding.title)}`)
        .join('\n')}\n\n</details>`,
    );
  }

  if (outcome.notes.length > 0) {
    parts.push(
      `<details><summary>정책 게이트 조정 내역 (${outcome.notes.length})</summary>\n\n${outcome.notes
        .map((note) => `- ${note}`)
        .join('\n')}\n\n</details>`,
    );
  }

  if (degraded.length > 0) {
    parts.push(`> ⚠️ 이 실행은 일부 단계가 실패한 상태로 완료되었습니다.\n${degraded.map((line) => `> - ${line}`).join('\n')}`);
  }

  parts.push(
    `<sub>run \`${context.runId}\` · head \`${context.pr.headSha.slice(0, 7)}\` · 변경 파일 ${context.changedFiles.length}개 · 로컬 멀티에이전트 리뷰</sub>`,
  );
  parts.push(summaryMarker());

  return parts.join('\n\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
