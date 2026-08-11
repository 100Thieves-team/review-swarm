import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRegistry } from "./agents/registry.js";
import { loadConfig } from "./config.js";
import { persist, renderBlackboard } from "./context/blackboard.js";
import { collectContext } from "./context/collect.js";
import { EnginePool } from "./engine/index.js";
import { dedupeFindings } from "./pipeline/dedup.js";
import { runDebates } from "./pipeline/debate.js";
import { runExperts } from "./pipeline/experts.js";
import { mediate } from "./pipeline/mediator.js";
import { applyPolicy } from "./pipeline/policy.js";
import { route } from "./pipeline/router.js";
import { verifyFindings } from "./pipeline/verify.js";
import { fetchPriorReview, fetchPullRequest, GitHubClient } from "./publish/github.js";
import { publishReview } from "./publish/publish.js";
import { parseMarker, parseTitle, renderSummary } from "./publish/render.js";
import { shortId } from "./util/text.js";
import { createLogger, timedStage } from "./util/logger.js";
/**
 * Router → fan-out → dedup/verify → selective debate → mediator → policy gate → GitHub.
 *
 * Every stage degrades instead of throwing: a review that posts eight of ten
 * findings is useful, a review that crashes is not.
 */
export async function runReview(options) {
    const startedAt = Date.now();
    const logger = options.logger ?? createLogger('swarm');
    const workdir = resolve(options.workdir);
    const degraded = [];
    const stageTimings = {};
    const { config: loaded, path: configPath } = loadConfig(workdir, options.configPath);
    const config = applyOverrides(loaded, options);
    logger.info(configPath ? `config: ${configPath}` : 'config: built-in defaults');
    const registry = buildRegistry(config, workdir, logger);
    const token = options.token;
    const pr = options.prInfo ??
        (await (async () => {
            if (!token)
                throw new Error('GitHub 토큰이 필요합니다 (GITHUB_TOKEN) — PR 정보를 가져올 수 없습니다');
            const client = new GitHubClient(token, options.apiUrl, logger);
            return fetchPullRequest(client, options.owner, options.repo, options.prNumber);
        })());
    const runId = shortId(`${pr.owner}/${pr.repo}`, String(pr.number), pr.headSha, String(startedAt)).slice(0, 8);
    const runDir = options.outDir
        ? resolve(options.outDir)
        : join(workdir, '.review-swarm', `${pr.number}-${pr.headSha.slice(0, 7)}-${runId}`);
    mkdirSync(runDir, { recursive: true });
    logger.info(`run ${runId} → ${runDir}`);
    const { context, parsed, ignoredFiles } = await timedStage('컨텍스트 수집', stageTimings, logger, () => collectContext({ config, workdir, runDir, runId, pr, ...(options.baseOverride ? { baseOverride: options.baseOverride } : {}), logger }));
    if (ignoredFiles.length > 0)
        logger.debug(`ignored: ${ignoredFiles.join(', ')}`);
    // Fetched once: the mediator uses it to drop rephrased repeats, and publishing
    // uses it to honour anything the author already closed.
    const prior = token
        ? await fetchPriorReview(new GitHubClient(token, options.apiUrl, logger), pr.owner, pr.repo, pr.number, parseMarker, parseTitle, logger)
        : [];
    persist(runDir, 'prior-review.json', prior);
    if (prior.length > 0) {
        logger.info(`prior review: ${prior.length} findings, ${prior.filter((p) => p.dismissed).length} closed by the author`);
    }
    const blackboard = renderBlackboard(context, config, prior);
    persist(runDir, 'blackboard.md', blackboard);
    const routing = route(config, registry, context.changedFiles, context.diff);
    persist(runDir, 'routing.json', {
        selected: routing.selected,
        reasons: Object.fromEntries(routing.reasons),
        fullSweep: routing.fullSweep,
    });
    logger.info(`router selected: ${routing.selected.join(', ') || '(없음)'}`);
    const pool = new EnginePool(config);
    const results = await timedStage('전문가 병렬 실행', stageTimings, logger, () => runExperts({ config, pool, registry, context, blackboard, selected: routing.selected, logger }));
    for (const result of results) {
        if (!result.ok)
            degraded.push(`\`${result.agentId}\` 실행 실패: ${result.error ?? 'unknown'}`);
    }
    let findings = dedupeFindings({ config, registry, parsed, results });
    logger.info(`findings: ${results.reduce((n, r) => n + r.findings.length, 0)} raw → ${findings.length} after dedup`);
    persist(runDir, 'findings.json', findings);
    findings = await timedStage('적대적 검증', stageTimings, logger, async () => {
        try {
            return await verifyFindings({ config, pool, registry, parsed, context, findings, logger });
        }
        catch (error) {
            degraded.push(`검증 단계 실패: ${String(error)}`);
            logger.warn(`verify stage failed: ${String(error)}`);
            return findings;
        }
    });
    await timedStage('선택적 토론', stageTimings, logger, async () => {
        try {
            await runDebates({ config, pool, registry, parsed, context, findings, selected: routing.selected, logger });
        }
        catch (error) {
            degraded.push(`토론 단계 실패: ${String(error)}`);
            logger.warn(`debate stage failed: ${String(error)}`);
        }
    });
    const mediation = await timedStage('조정자 판정', stageTimings, logger, () => mediate({ config, pool, registry, context, findings, prior, logger }));
    if (!mediation.ok && mediation.error)
        degraded.push(`조정자 실패: ${mediation.error}`);
    const outcome = applyPolicy(config, registry, findings);
    persist(runDir, 'outcome.json', {
        event: outcome.event,
        inline: outcome.inline.map(summarizeFinding),
        summaryOnly: outcome.summaryOnly.map(summarizeFinding),
        dropped: outcome.dropped.map(summarizeFinding),
        notes: outcome.notes,
    });
    logger.info(`policy: ${outcome.inline.length} inline, ${outcome.summaryOnly.length} summary-only, ${outcome.dropped.length} dropped → ${outcome.event}`);
    const publish = await timedStage('GitHub 게시', stageTimings, logger, () => publishReview({
        config,
        context,
        registry,
        outcome,
        fallbackToken: token,
        prior,
        ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
        dryRun: options.dryRun,
        logger,
        makeSummary: (skipped, dismissed) => renderSummary({
            config,
            context,
            registry,
            routing,
            results,
            outcome,
            mediatorSummary: mediation.summary,
            skipped,
            dismissed,
            durationMs: Date.now() - startedAt,
            degraded,
        }),
    }));
    for (const error of publish.errors)
        logger.error(`publish: ${error}`);
    const durationMs = Date.now() - startedAt;
    persist(runDir, 'run.json', {
        runId,
        pr: { owner: pr.owner, repo: pr.repo, number: pr.number, headSha: pr.headSha },
        routing: routing.selected,
        event: outcome.event,
        inline: outcome.inline.length,
        summaryOnly: outcome.summaryOnly.length,
        dropped: outcome.dropped.length,
        skipped: publish.skipped.length,
        posted: publish.posted,
        errors: publish.errors,
        degraded,
        durationMs,
        stageTimings,
        agentTimings: Object.fromEntries(results.map((result) => [result.agentId, result.durationMs])),
    });
    return { runId, runDir, outcome, publish, degraded, durationMs };
}
function summarizeFinding(finding) {
    return {
        id: finding.id,
        owner: finding.owner,
        agents: finding.agents,
        file: finding.file,
        line: finding.anchor?.line ?? finding.start_line,
        severity: finding.severity,
        confidence: finding.confidence,
        category: finding.category,
        title: finding.title,
        verdict: finding.verdict,
        verdictReason: finding.verdictReason,
        refuted: finding.verification?.refuted ?? null,
    };
}
function applyOverrides(config, options) {
    if (!options.engineOverride)
        return config;
    return {
        ...config,
        engine: { ...config.engine, default: options.engineOverride },
        agents: Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, { ...agent, engine: options.engineOverride }])),
        verify: { ...config.verify, engine: options.engineOverride },
        debate: { ...config.debate, engine: options.engineOverride },
        mediator: { ...config.mediator, engine: options.engineOverride },
    };
}
//# sourceMappingURL=orchestrator.js.map