import { HARNESS_RULES } from "../agents/personas.js";
import { persist } from "../context/blackboard.js";
import { FINDINGS_SCHEMA, SEVERITIES } from "../types.js";
import { mapLimit } from "../util/concurrency.js";
import { asArray, asEnum, asInt, asNumber, asRecord, asString, clamp } from "../util/json.js";
import { normalizePath } from "../util/text.js";
export async function runExperts(options) {
    const { config, pool, registry, context, blackboard, selected, logger } = options;
    return mapLimit(selected, config.engine.concurrency, async (agentId) => {
        const agent = registry.get(agentId);
        if (!agent) {
            return { agentId, ok: false, durationMs: 0, error: 'agent not registered', notes: null, findings: [] };
        }
        const prompt = buildExpertPrompt(agent, blackboard, config);
        persist(context.runDir, `prompts/${agentId}.md`, prompt);
        const { engine, model, effort, timeoutMs } = pool.resolve(config.agents[agentId]);
        const started = Date.now();
        let lastError = 'unknown error';
        for (let attempt = 0; attempt <= config.engine.retries; attempt += 1) {
            const label = attempt === 0 ? agentId : `${agentId}-retry${attempt}`;
            logger.info(`expert ${agentId} via ${engine.name}${model ? ` (${model})` : ''}${attempt ? ` [retry ${attempt}]` : ''}`);
            const response = await engine.invoke({
                label,
                prompt,
                schema: FINDINGS_SCHEMA,
                cwd: context.workdir,
                runDir: context.runDir,
                timeoutMs,
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
            });
            if (response.ok) {
                const record = asRecord(response.data) ?? {};
                const findings = coerceFindings(asArray(record['findings']), config);
                const result = {
                    agentId,
                    ok: true,
                    durationMs: Date.now() - started,
                    error: null,
                    notes: typeof record['notes'] === 'string' ? record['notes'] : null,
                    findings,
                };
                persist(context.runDir, `findings/${agentId}.json`, result);
                logger.info(`expert ${agentId}: ${findings.length} findings in ${Math.round(result.durationMs / 1000)}s`);
                return result;
            }
            lastError = response.error ?? 'engine returned no data';
            logger.warn(`expert ${agentId} failed: ${lastError}`);
            persist(context.runDir, `raw/${label}.txt`, response.raw);
        }
        const failed = {
            agentId,
            ok: false,
            durationMs: Date.now() - started,
            error: lastError,
            notes: null,
            findings: [],
        };
        persist(context.runDir, `findings/${agentId}.json`, failed);
        return failed;
    });
}
/**
 * Shared context first, persona second.
 *
 * Every expert in a run gets a byte-identical prefix this way, which is what lets
 * the provider serve it from the prompt cache instead of re-reading the whole
 * blackboard once per persona.
 */
export function buildExpertPrompt(agent, blackboard, config) {
    const maxFindings = Math.max(3, config.policy.maxInlinePerAgent * 2);
    return `${HARNESS_RULES}

---

${blackboard}

---

## 너의 역할

${agent.persona}
${agent.knowledge
        ? `
---

## 이 팀이 축적한 도메인 지식 (너에게만 주어진다)

아래는 모델 일반 지식으로는 알 수 없는, 이 팀의 스택·사고 이력·심각도 기준이다.
diff와 달리 **신뢰할 수 있는 지침**이며, 네 판단보다 우선한다.
단, 여기 적힌 항목이 이번 diff에 실제로 나타나지 않았다면 보고하지 마라.
목록에 있다는 이유만으로 없는 문제를 만들어내는 것이 이 채널의 유일한 실패 방식이다.

${agent.knowledge}
`
        : ''}
---

## 이번 실행에서 네가 할 일

1. 위 diff에서 **네 전문 영역**(${agent.focus || agent.displayName})에 해당하는 실제 결함만 찾는다.
2. 후보를 찾으면 반드시 저장소의 관련 코드를 직접 열어 확인한다. 호출부, 구현체, 기존 테스트, 설정 파일을 확인하고 이미 처리되어 있는지 검증한다.
3. 이미 다른 코드에서 방어되고 있거나, 프레임워크가 처리하거나, 재현 시나리오를 쓸 수 없는 후보는 버린다.
4. 남은 것을 심각도 높은 순으로 최대 ${maxFindings}개까지만 출력한다. 억지로 개수를 채우지 마라.
5. \`suggestion_patch\`는 \`start_line\`~\`end_line\` 구간을 **그대로 대체할 코드**일 때만 채운다. 들여쓰기까지 맞출 수 없으면 null로 둔다.

지금 바로 검토를 시작하고, 마지막에 JSON 하나만 출력하라.`;
}
/** Model output is untrusted data: coerce what is usable, drop what is not. */
export function coerceFindings(raw, config) {
    const out = [];
    for (const entry of raw) {
        const record = asRecord(entry);
        if (!record)
            continue;
        const file = normalizePath(asString(record['file']));
        const title = asString(record['title']).trim();
        if (!file || !title)
            continue;
        const start = asInt(record['start_line'], 0);
        const end = asInt(record['end_line'], start);
        const confidence = clamp(asNumber(record['confidence'], 0.6), 0, 1);
        if (confidence < config.policy.dropBelowConfidence)
            continue;
        out.push({
            file,
            start_line: Math.max(1, Math.min(start || end || 1, end || start || 1)),
            end_line: Math.max(1, Math.max(start || 1, end || start || 1)),
            side: asEnum(record['side'], ['RIGHT', 'LEFT'], 'RIGHT'),
            severity: asEnum(record['severity'], SEVERITIES, 'medium'),
            confidence,
            category: slug(asString(record['category'], 'general')),
            title: title.slice(0, 200),
            rationale: asString(record['rationale']).trim(),
            evidence: asString(record['evidence']).trim(),
            scenario: asString(record['scenario']).trim(),
            suggested_fix: asString(record['suggested_fix']).trim(),
            suggestion_patch: typeof record['suggestion_patch'] === 'string' && record['suggestion_patch'].trim()
                ? record['suggestion_patch']
                : null,
        });
    }
    return out;
}
function slug(text) {
    const normalized = text
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9가-힣-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return normalized || 'general';
}
//# sourceMappingURL=experts.js.map