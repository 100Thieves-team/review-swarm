import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
export const CONFIG_FILENAMES = [
    '.review-swarm.yaml',
    '.review-swarm.yml',
    '.github/review-swarm.yaml',
    '.github/review-swarm.yml',
];
export const DEFAULT_CONFIG = {
    version: 1,
    engine: {
        default: 'claude',
        concurrency: 4,
        timeoutMs: 900_000,
        retries: 1,
        claude: {
            bin: 'claude',
            model: 'sonnet',
            tools: ['Read', 'Grep', 'Glob'],
            permissionMode: 'bypassPermissions',
            extraArgs: [],
            settingSources: 'project',
        },
        codex: {
            bin: 'codex',
            model: '',
            sandbox: 'read-only',
            ephemeral: true,
            extraArgs: [],
            configOverrides: [],
        },
    },
    agents: {
        security: { id: 'security', enabled: true },
        consistency: { id: 'consistency', enabled: true },
        performance: { id: 'performance', enabled: true },
        architect: { id: 'architect', enabled: true },
        pragmatist: { id: 'pragmatist', enabled: true },
        collaborator: { id: 'collaborator', enabled: true },
        mediator: { id: 'mediator', enabled: true },
    },
    router: {
        always: ['security', 'pragmatist'],
        rules: [
            {
                name: 'persistence',
                paths: [
                    '**/repository/**',
                    '**/repositories/**',
                    '**/*Repository.*',
                    '**/dao/**',
                    '**/entity/**',
                    '**/entities/**',
                    '**/*Entity.*',
                    '**/migrations/**',
                    '**/migration/**',
                    '**/*.sql',
                    '**/schema.prisma',
                    '**/models.py',
                ],
                content: ['SELECT ', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', '@Query', 'findAll', 'createQueryBuilder'],
                add: ['performance', 'consistency'],
            },
            {
                name: 'auth',
                paths: [
                    '**/auth/**',
                    '**/security/**',
                    '**/*Security*.*',
                    '**/middleware/**',
                    '**/guard*/**',
                    '**/*Guard.*',
                    '**/*Interceptor.*',
                    '**/permission*/**',
                ],
                content: ['jwt', 'token', 'password', 'secret', 'authorize', 'authenticate', 'hasRole', 'tenant'],
                add: ['security', 'collaborator'],
            },
            {
                name: 'domain',
                paths: [
                    '**/domain/**',
                    '**/service/**',
                    '**/services/**',
                    '**/*Service.*',
                    '**/usecase/**',
                    '**/usecases/**',
                    '**/application/**',
                ],
                content: [],
                add: ['consistency', 'architect'],
            },
            {
                name: 'external-io',
                paths: ['**/client/**', '**/clients/**', '**/*Client.*', '**/gateway/**', '**/adapter*/**'],
                content: ['fetch(', 'axios', 'httpClient', 'RestTemplate', 'WebClient', 'requests.'],
                add: ['consistency', 'performance'],
            },
            {
                name: 'api-contract',
                paths: [
                    '**/controller/**',
                    '**/controllers/**',
                    '**/*Controller.*',
                    '**/routes/**',
                    '**/api/**',
                    '**/*.proto',
                    '**/openapi*.{yaml,yml,json}',
                ],
                content: [],
                add: ['collaborator', 'security'],
            },
            {
                name: 'concurrency',
                paths: [],
                content: ['@Transactional', 'BEGIN;', 'lock', 'Lock(', 'synchronized', 'Mutex', 'kafka', 'sqs', 'rabbit', 'retry'],
                add: ['consistency'],
            },
            {
                name: 'ops-surface',
                paths: [
                    '**/.github/workflows/**',
                    '**/Dockerfile*',
                    '**/compose*.{yaml,yml}',
                    '**/*.tf',
                    '**/helm/**',
                    '**/k8s/**',
                    '**/*.env.example',
                ],
                content: [],
                add: ['collaborator', 'security'],
            },
            {
                name: 'structure',
                paths: ['**/*.{ts,tsx,js,java,kt,go,rs,py,rb,cs,scala,swift}'],
                content: [],
                add: ['architect'],
            },
        ],
        maxAgents: 6,
        fullSweepChangedLines: 400,
    },
    verify: {
        enabled: true,
        minSeverity: 'medium',
        voters: 1,
        refuteThreshold: 0.5,
    },
    debate: {
        enabled: true,
        maxPairs: 3,
    },
    mediator: {
        enabled: true,
    },
    policy: {
        gateAgents: ['security', 'consistency'],
        analystAgents: ['performance'],
        valueAgents: ['architect', 'pragmatist', 'collaborator'],
        blockMinSeverity: 'high',
        blockMinConfidence: 0.7,
        requireAnalystEvidence: true,
        maxInlinePerAgent: 6,
        maxInlineTotal: 25,
        maxSnapDistance: 20,
        dropBelowSeverity: 'info',
        dropBelowConfidence: 0.45,
    },
    publish: {
        mode: 'apps',
        event: 'auto',
        approveWhenClean: false,
        minimizeStale: false,
        language: 'ko',
        summaryAgent: 'mediator',
        skipDuplicates: true,
    },
    context: {
        diffContextLines: 5,
        maxDiffChars: 600_000,
        maxPromptDiffChars: 160_000,
        teamRuleFiles: ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/review-rules.md', '.github/review-rules.md'],
        maxTeamRuleChars: 12_000,
    },
    checks: [],
    ignore: [
        '**/*.lock',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
        '**/Cargo.lock',
        '**/go.sum',
        '**/*.min.js',
        '**/*.map',
        '**/dist/**',
        '**/build/**',
        '**/vendor/**',
        '**/node_modules/**',
        '**/__snapshots__/**',
        '**/*.svg',
        '**/*.png',
        '**/*.jpg',
        '**/*.pdf',
    ],
};
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Deep merge where arrays are replaced wholesale — a user list should not append to defaults. */
function merge(base, override) {
    if (override === undefined || override === null)
        return base;
    if (!isPlainObject(base) || !isPlainObject(override))
        return override;
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = merge(base[key], value);
    }
    return out;
}
export function findConfigFile(workdir) {
    for (const name of CONFIG_FILENAMES) {
        const candidate = resolve(workdir, name);
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
export function loadConfig(workdir, explicitPath) {
    const path = explicitPath ? resolve(explicitPath) : findConfigFile(workdir);
    if (!path)
        return { config: normalize(DEFAULT_CONFIG), path: null };
    if (!existsSync(path))
        throw new Error(`config file not found: ${path}`);
    const text = readFileSync(path, 'utf8');
    const parsed = (path.endsWith('.json') ? JSON.parse(text) : parseYaml(text));
    if (parsed !== null && parsed !== undefined && !isPlainObject(parsed)) {
        throw new Error(`config file must contain a mapping: ${path}`);
    }
    return { config: normalize(merge(DEFAULT_CONFIG, parsed ?? {})), path };
}
/** Fill in derived fields and reject values that would misbehave silently. */
export function normalize(config) {
    const out = merge(DEFAULT_CONFIG, config);
    for (const [id, agent] of Object.entries(out.agents)) {
        out.agents[id] = { ...agent, id };
    }
    out.engine.concurrency = Math.max(1, Math.trunc(out.engine.concurrency));
    out.engine.retries = Math.max(0, Math.trunc(out.engine.retries));
    out.router.maxAgents = Math.max(1, Math.trunc(out.router.maxAgents));
    out.verify.voters = Math.max(1, Math.trunc(out.verify.voters));
    out.policy.maxInlineTotal = Math.max(1, Math.trunc(out.policy.maxInlineTotal));
    out.policy.maxInlinePerAgent = Math.max(1, Math.trunc(out.policy.maxInlinePerAgent));
    out.checks = out.checks.map((check, index) => {
        if (!check?.run)
            throw new Error(`checks[${index}] needs a "run" command`);
        return {
            name: check.name || `check-${index + 1}`,
            run: check.run,
            timeoutMs: check.timeoutMs && check.timeoutMs > 0 ? check.timeoutMs : 600_000,
            maxOutputChars: check.maxOutputChars && check.maxOutputChars > 0 ? check.maxOutputChars : 8_000,
        };
    });
    if (!['apps', 'single', 'none'].includes(out.publish.mode)) {
        throw new Error(`publish.mode must be apps, single or none (got "${out.publish.mode}")`);
    }
    if (!['auto', 'comment', 'request_changes'].includes(out.publish.event)) {
        throw new Error(`publish.event must be auto, comment or request_changes (got "${out.publish.event}")`);
    }
    const known = new Set(Object.keys(out.agents));
    const unknownPolicyAgent = [...out.policy.gateAgents, ...out.policy.analystAgents, ...out.policy.valueAgents].find((id) => !known.has(id));
    if (unknownPolicyAgent) {
        throw new Error(`policy references unknown agent "${unknownPolicyAgent}"; define it under agents:`);
    }
    const unknownRouterAgent = [...out.router.always, ...out.router.rules.flatMap((rule) => rule.add)].find((id) => !known.has(id));
    if (unknownRouterAgent) {
        throw new Error(`router references unknown agent "${unknownRouterAgent}"; define it under agents:`);
    }
    return out;
}
/** The class a persona belongs to, which decides how much authority it has. */
export function agentClass(config, agentId) {
    if (agentId === 'mediator')
        return 'mediator';
    if (config.policy.gateAgents.includes(agentId))
        return 'gate';
    if (config.policy.analystAgents.includes(agentId))
        return 'analyst';
    return 'value';
}
//# sourceMappingURL=config.js.map