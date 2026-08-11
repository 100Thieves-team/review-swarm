import { authenticateApp, createReview, DEFAULT_API_URL, GitHubClient, listReviewComments, minimizeComment, readAppCredentials, upsertIssueComment, } from "./github.js";
import { MARKER_PREFIX, parseFingerprint, renderFindingBody, summaryMarker } from "./render.js";
export async function publishReview(options) {
    const { config, context, registry, outcome, makeSummary, fallbackToken, prior, dryRun, logger } = options;
    const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
    const { owner, repo, number, headSha } = context.pr;
    const result = { posted: [], skipped: [], dismissed: [], errors: [], summaryUrl: null };
    if (config.publish.mode === 'none' || dryRun) {
        const summary = makeSummary([], []);
        logger.info(dryRun ? 'dry run — nothing posted' : 'publish.mode=none — nothing posted');
        logger.debug(`summary preview:\n${summary}`);
        return result;
    }
    const identities = await resolveIdentities(config, registry, outcome, owner, repo, apiUrl, fallbackToken, logger);
    const baseIdentity = identities.get('__fallback__');
    if (!baseIdentity) {
        result.errors.push('게시에 쓸 자격이 없습니다 — GITHUB_TOKEN 또는 에이전트 GitHub App 자격이 필요합니다.');
        return result;
    }
    const baseClient = new GitHubClient(baseIdentity.token, apiUrl, logger);
    const existing = config.publish.minimizeStale
        ? await listReviewComments(baseClient, owner, repo, number).catch((error) => {
            logger.warn(`could not list existing comments: ${String(error)}`);
            return [];
        })
        : [];
    // A dismissal is the author's decision, so it is enforced here rather than left
    // to the mediator's judgement — the model advises, this gate is absolute.
    const dismissed = new Set(prior.filter((entry) => entry.dismissed).map((entry) => entry.fingerprint));
    const seen = new Set(prior.map((entry) => entry.fingerprint));
    const fresh = [];
    for (const finding of outcome.inline) {
        if (dismissed.has(finding.fingerprint))
            result.dismissed.push(finding);
        else if (config.publish.skipDuplicates && seen.has(finding.fingerprint))
            result.skipped.push(finding);
        else
            fresh.push(finding);
    }
    if (result.dismissed.length > 0) {
        logger.info(`${result.dismissed.length} findings suppressed — closed by the author earlier`);
    }
    const byAgent = new Map();
    for (const finding of fresh) {
        const bucket = byAgent.get(finding.owner);
        if (bucket)
            bucket.push(finding);
        else
            byAgent.set(finding.owner, [finding]);
    }
    for (const [agentId, findings] of byAgent) {
        const agent = registry.get(agentId);
        const identity = identities.get(agentId) ?? identities.get('__fallback__');
        if (!identity) {
            result.errors.push(`${agentId}: 사용할 수 있는 GitHub 자격이 없습니다`);
            continue;
        }
        const client = new GitHubClient(identity.token, apiUrl, logger);
        const comments = findings.map((finding) => toReviewComment(finding, agent, identity));
        const body = `${agent?.emoji ?? '🔎'} **${agent?.displayName ?? agentId}** — ${findings.length}건${agent?.focus ? `\n\n<sub>${agent.focus}</sub>` : ''}`;
        const posted = await createReview(client, owner, repo, number, { commit_id: headSha, body, event: 'COMMENT', comments }, logger);
        result.posted.push({
            agent: agentId,
            identity: identity.slug ? `${identity.slug}[bot]` : identity.name,
            comments: posted.postedComments,
            url: posted.htmlUrl,
        });
        if (!posted.ok && posted.error)
            result.errors.push(`${agentId}: ${posted.error}`);
        else if (posted.error)
            logger.warn(`${agentId}: ${posted.error}`);
    }
    // The gate speaks last, and it is the only identity allowed to change the state.
    const summaryAgentId = config.publish.summaryAgent;
    const summaryIdentity = identities.get(summaryAgentId) ?? identities.get('__fallback__');
    const summaryBody = makeSummary(result.skipped, result.dismissed);
    if (summaryIdentity) {
        const client = new GitHubClient(summaryIdentity.token, apiUrl, logger);
        if (outcome.event !== 'REQUEST_CHANGES') {
            await dismissStaleRequestChanges(client, owner, repo, number, logger);
        }
        const posted = await createReview(client, owner, repo, number, { commit_id: headSha, body: summaryBody, event: outcome.event, comments: [] }, logger);
        result.summaryUrl = posted.htmlUrl;
        if (!posted.ok && posted.error) {
            result.errors.push(`summary: ${posted.error}`);
            // A review can be refused (e.g. reviewing your own PR); an issue comment cannot.
            try {
                await upsertIssueComment(client, owner, repo, number, summaryMarker(), summaryBody);
            }
            catch (error) {
                result.errors.push(`summary fallback: ${String(error)}`);
            }
        }
    }
    else {
        result.errors.push('요약을 게시할 자격이 없습니다');
    }
    if (config.publish.minimizeStale) {
        const current = new Set([...outcome.inline, ...outcome.summaryOnly].map((finding) => finding.fingerprint));
        for (const comment of existing) {
            if (!comment.body.includes(MARKER_PREFIX))
                continue;
            const fingerprint = parseFingerprint(comment.body);
            if (fingerprint && !current.has(fingerprint)) {
                await minimizeComment(baseClient, comment.nodeId, logger);
            }
        }
    }
    return result;
}
function toReviewComment(finding, agent, identity) {
    const anchor = finding.anchor;
    if (!anchor)
        throw new Error(`finding ${finding.id} has no anchor; policy should have filtered it`);
    const body = renderFindingBody(finding, agent, { includeAgentHeader: identity.source !== 'app' });
    const comment = { path: anchor.path, line: anchor.line, side: anchor.side, body };
    if (anchor.startLine !== null && anchor.startSide !== null) {
        comment.start_line = anchor.startLine;
        comment.start_side = anchor.startSide;
    }
    return comment;
}
/** One identity per agent; agents without their own App fall back to the shared token. */
async function resolveIdentities(config, registry, outcome, owner, repo, apiUrl, fallbackToken, logger) {
    const identities = new Map();
    if (fallbackToken) {
        identities.set('__fallback__', { token: fallbackToken, slug: null, name: 'github-actions', source: 'token' });
    }
    if (config.publish.mode !== 'apps')
        return identities;
    const needed = new Set([config.publish.summaryAgent, ...outcome.inline.map((finding) => finding.owner)]);
    for (const agentId of needed) {
        const agent = registry.get(agentId);
        if (!agent)
            continue;
        const credentials = readAppCredentials(agent.appEnvPrefix);
        if (!credentials) {
            logger.warn(`${agentId}: ${agent.appEnvPrefix}_APP_ID/_PRIVATE_KEY 미설정 — 공용 토큰으로 게시합니다`);
            continue;
        }
        try {
            const identity = await authenticateApp(credentials, owner, repo, apiUrl, logger);
            identities.set(agentId, identity);
            logger.info(`${agentId}: authenticated as ${identity.slug ? `${identity.slug}[bot]` : identity.name}`);
        }
        catch (error) {
            logger.warn(`${agentId}: GitHub App 인증 실패 (${String(error)}) — 공용 토큰으로 게시합니다`);
        }
    }
    // With Apps configured but no shared token, an App installation token still lets
    // the run read existing comments and post the summary.
    if (!identities.has('__fallback__')) {
        const preferred = identities.get(config.publish.summaryAgent) ?? [...identities.values()][0];
        if (preferred)
            identities.set('__fallback__', preferred);
    }
    return identities;
}
/**
 * Dismiss our own earlier "changes requested" once the problems are gone.
 *
 * Without this the first blocking run keeps the PR red forever, since GitHub only
 * clears the state when the review that set it is dismissed.
 */
async function dismissStaleRequestChanges(client, owner, repo, number, logger) {
    try {
        const reviews = await client.paginate(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
        const stale = reviews.filter((review) => review.state === 'CHANGES_REQUESTED' && (review.body ?? '').includes(MARKER_PREFIX));
        for (const review of stale) {
            await client.request('PUT', `/repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}/dismissals`, {
                message: '후속 커밋에서 차단 사유가 해소되어 자동 해제되었습니다. (review-swarm)',
                event: 'DISMISS',
            });
            logger.info(`dismissed stale CHANGES_REQUESTED review ${review.id}`);
        }
    }
    catch (error) {
        logger.warn(`could not dismiss stale reviews: ${String(error)}`);
    }
}
//# sourceMappingURL=publish.js.map