import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentClass } from "../config.js";
import { PERSONAS } from "./personas.js";
import { truncate } from "../util/text.js";
const METADATA = {
    security: {
        displayName: 'Security Sentinel',
        emoji: '🛡️',
        focus: '인증·인가 우회, 인젝션, 비밀정보 노출, 테넌트 경계',
    },
    consistency: {
        displayName: 'Consistency Guardian',
        emoji: '🧮',
        focus: '트랜잭션 경계, 멱등성, 부분 실패, 동시성',
    },
    performance: {
        displayName: 'Performance Analyst',
        emoji: '⚡',
        focus: 'N+1, 인덱스, 락 범위, 외부 호출 비용',
    },
    architect: {
        displayName: 'Architect',
        emoji: '🏛️',
        focus: '변경 비용, 책임 분리, 결합도, 테스트 용이성',
    },
    pragmatist: {
        displayName: 'Pragmatist',
        emoji: '🎯',
        focus: '과설계 차단, 최소 변경, 운영 부담',
    },
    collaborator: {
        displayName: 'Collaborator',
        emoji: '🤝',
        focus: '팀 컨벤션, 계약 변경 전달, 운영 가능성',
    },
    mediator: {
        displayName: 'Review Mediator',
        emoji: '⚖️',
        focus: '가치 충돌 조정, 최종 판정',
    },
};
export function buildRegistry(config, workdir, logger) {
    const registry = new Map();
    for (const [id, agent] of Object.entries(config.agents)) {
        if (!agent.enabled)
            continue;
        const meta = METADATA[id] ?? { displayName: id, emoji: '🔎', focus: '' };
        let persona = PERSONAS[id] ?? '';
        if (agent.personaFile) {
            persona = readFileSync(resolve(workdir, agent.personaFile), 'utf8');
        }
        if (!persona) {
            throw new Error(`agent "${id}" has no built-in persona; set agents.${id}.personaFile`);
        }
        if (agent.extraInstructions) {
            persona = `${persona}\n\n## 이 저장소의 추가 지침\n${agent.extraInstructions}`;
        }
        registry.set(id, {
            id,
            displayName: meta.displayName,
            emoji: meta.emoji,
            appEnvPrefix: agent.appEnvPrefix ?? `SWARM_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
            klass: agentClass(config, id),
            persona,
            focus: meta.focus,
            knowledge: readKnowledge(id, agent.knowledgeFiles ?? [], workdir, config.context.maxAgentKnowledgeChars, logger),
        });
    }
    return registry;
}
/**
 * Load one agent's knowledge files.
 *
 * A configured file that has gone missing is reported rather than skipped: the
 * whole point of this channel is knowledge the model cannot recover on its own,
 * so losing it silently is the worst failure mode.
 */
function readKnowledge(agentId, files, workdir, maxChars, logger) {
    if (files.length === 0)
        return '';
    const sections = [];
    let budget = maxChars;
    for (const relative of files) {
        if (budget <= 0) {
            logger?.warn(`agents.${agentId}.knowledgeFiles: budget exhausted before "${relative}"`);
            break;
        }
        const path = resolve(workdir, relative);
        if (!existsSync(path)) {
            logger?.warn(`agents.${agentId}.knowledgeFiles not found: ${relative}`);
            continue;
        }
        try {
            const body = truncate(readFileSync(path, 'utf8').trim(), budget);
            if (!body)
                continue;
            sections.push(`### ${relative}\n${body}`);
            budget -= body.length;
        }
        catch (error) {
            logger?.warn(`agents.${agentId}.knowledgeFiles unreadable "${relative}": ${String(error)}`);
        }
    }
    return sections.join('\n\n');
}
/** Experts are everyone who produces findings — the mediator only judges them. */
export function expertIds(registry) {
    return [...registry.values()].filter((agent) => agent.klass !== 'mediator').map((agent) => agent.id);
}
//# sourceMappingURL=registry.js.map