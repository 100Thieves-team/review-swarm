import type { AgentDefinition } from '../agents/registry.ts';
import type { SwarmConfig } from '../config.ts';
import type { PolicyOutcome } from '../pipeline/policy.ts';
import type { Finding, ReviewContext } from '../types.ts';
import type { Logger } from '../util/logger.ts';
import {
  authenticateApp,
  createReview,
  DEFAULT_API_URL,
  GitHubClient,
  listReviewComments,
  minimizeComment,
  readAppCredentials,
  upsertIssueComment,
  type GitHubIdentity,
  type ReviewComment,
} from './github.ts';
import { MARKER_PREFIX, parseFingerprint, renderFindingBody, summaryMarker } from './render.ts';

export interface PublishOptions {
  config: SwarmConfig;
  context: ReviewContext;
  registry: Map<string, AgentDefinition>;
  outcome: PolicyOutcome;
  /** Built after duplicate detection, because the summary reports what was skipped. */
  makeSummary: (skipped: Finding[]) => string;
  fallbackToken: string | null;
  apiUrl?: string;
  dryRun: boolean;
  logger: Logger;
}

export interface PublishResult {
  posted: { agent: string; identity: string; comments: number; url: string | null }[];
  skipped: Finding[];
  errors: string[];
  summaryUrl: string | null;
}

export async function publishReview(options: PublishOptions): Promise<PublishResult> {
  const { config, context, registry, outcome, makeSummary, fallbackToken, dryRun, logger } = options;
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
  const { owner, repo, number, headSha } = context.pr;

  const result: PublishResult = { posted: [], skipped: [], errors: [], summaryUrl: null };

  if (config.publish.mode === 'none' || dryRun) {
    const summary = makeSummary([]);
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

  // Existing fingerprints let a re-run on a new commit stay quiet about what it
  // already said, instead of repeating every comment on every push.
  const existing = config.publish.skipDuplicates
    ? await listReviewComments(baseClient, owner, repo, number).catch((error) => {
        logger.warn(`could not list existing comments: ${String(error)}`);
        return [];
      })
    : [];
  const seen = new Set(existing.map((comment) => parseFingerprint(comment.body)).filter((fp): fp is string => !!fp));

  const fresh: Finding[] = [];
  for (const finding of outcome.inline) {
    if (seen.has(finding.fingerprint)) result.skipped.push(finding);
    else fresh.push(finding);
  }

  const byAgent = new Map<string, Finding[]>();
  for (const finding of fresh) {
    const bucket = byAgent.get(finding.owner);
    if (bucket) bucket.push(finding);
    else byAgent.set(finding.owner, [finding]);
  }

  for (const [agentId, findings] of byAgent) {
    const agent = registry.get(agentId);
    const identity = identities.get(agentId) ?? identities.get('__fallback__');
    if (!identity) {
      result.errors.push(`${agentId}: 사용할 수 있는 GitHub 자격이 없습니다`);
      continue;
    }

    const client = new GitHubClient(identity.token, apiUrl, logger);
    const comments: ReviewComment[] = findings.map((finding) => toReviewComment(finding, agent, identity));
    const body = `${agent?.emoji ?? '🔎'} **${agent?.displayName ?? agentId}** — ${findings.length}건${agent?.focus ? `\n\n<sub>${agent.focus}</sub>` : ''}`;

    const posted = await createReview(
      client,
      owner,
      repo,
      number,
      { commit_id: headSha, body, event: 'COMMENT', comments },
      logger,
    );

    result.posted.push({
      agent: agentId,
      identity: identity.slug ? `${identity.slug}[bot]` : identity.name,
      comments: posted.postedComments,
      url: posted.htmlUrl,
    });
    if (!posted.ok && posted.error) result.errors.push(`${agentId}: ${posted.error}`);
    else if (posted.error) logger.warn(`${agentId}: ${posted.error}`);
  }

  // The gate speaks last, and it is the only identity allowed to change the state.
  const summaryAgentId = config.publish.summaryAgent;
  const summaryIdentity = identities.get(summaryAgentId) ?? identities.get('__fallback__');
  const summaryBody = makeSummary(result.skipped);

  if (summaryIdentity) {
    const client = new GitHubClient(summaryIdentity.token, apiUrl, logger);

    if (outcome.event !== 'REQUEST_CHANGES') {
      await dismissStaleRequestChanges(client, owner, repo, number, logger);
    }

    const posted = await createReview(
      client,
      owner,
      repo,
      number,
      { commit_id: headSha, body: summaryBody, event: outcome.event, comments: [] },
      logger,
    );
    result.summaryUrl = posted.htmlUrl;
    if (!posted.ok && posted.error) {
      result.errors.push(`summary: ${posted.error}`);
      // A review can be refused (e.g. reviewing your own PR); an issue comment cannot.
      try {
        await upsertIssueComment(client, owner, repo, number, summaryMarker(), summaryBody);
      } catch (error) {
        result.errors.push(`summary fallback: ${String(error)}`);
      }
    }
  } else {
    result.errors.push('요약을 게시할 자격이 없습니다');
  }

  if (config.publish.minimizeStale) {
    const current = new Set([...outcome.inline, ...outcome.summaryOnly].map((finding) => finding.fingerprint));
    for (const comment of existing) {
      if (!comment.body.includes(MARKER_PREFIX)) continue;
      const fingerprint = parseFingerprint(comment.body);
      if (fingerprint && !current.has(fingerprint)) {
        await minimizeComment(baseClient, comment.nodeId, logger);
      }
    }
  }

  return result;
}

function toReviewComment(
  finding: Finding,
  agent: AgentDefinition | undefined,
  identity: GitHubIdentity,
): ReviewComment {
  const anchor = finding.anchor;
  if (!anchor) throw new Error(`finding ${finding.id} has no anchor; policy should have filtered it`);

  const body = renderFindingBody(finding, agent, { includeAgentHeader: identity.source !== 'app' });
  const comment: ReviewComment = { path: anchor.path, line: anchor.line, side: anchor.side, body };
  if (anchor.startLine !== null && anchor.startSide !== null) {
    comment.start_line = anchor.startLine;
    comment.start_side = anchor.startSide;
  }
  return comment;
}

/** One identity per agent; agents without their own App fall back to the shared token. */
async function resolveIdentities(
  config: SwarmConfig,
  registry: Map<string, AgentDefinition>,
  outcome: PolicyOutcome,
  owner: string,
  repo: string,
  apiUrl: string,
  fallbackToken: string | null,
  logger: Logger,
): Promise<Map<string, GitHubIdentity>> {
  const identities = new Map<string, GitHubIdentity>();
  if (fallbackToken) {
    identities.set('__fallback__', { token: fallbackToken, slug: null, name: 'github-actions', source: 'token' });
  }

  if (config.publish.mode !== 'apps') return identities;

  const needed = new Set<string>([config.publish.summaryAgent, ...outcome.inline.map((finding) => finding.owner)]);

  for (const agentId of needed) {
    const agent = registry.get(agentId);
    if (!agent) continue;
    const credentials = readAppCredentials(agent.appEnvPrefix);
    if (!credentials) {
      logger.warn(`${agentId}: ${agent.appEnvPrefix}_APP_ID/_PRIVATE_KEY 미설정 — 공용 토큰으로 게시합니다`);
      continue;
    }
    try {
      const identity = await authenticateApp(credentials, owner, repo, apiUrl, logger);
      identities.set(agentId, identity);
      logger.info(`${agentId}: authenticated as ${identity.slug ? `${identity.slug}[bot]` : identity.name}`);
    } catch (error) {
      logger.warn(`${agentId}: GitHub App 인증 실패 (${String(error)}) — 공용 토큰으로 게시합니다`);
    }
  }

  // With Apps configured but no shared token, an App installation token still lets
  // the run read existing comments and post the summary.
  if (!identities.has('__fallback__')) {
    const preferred = identities.get(config.publish.summaryAgent) ?? [...identities.values()][0];
    if (preferred) identities.set('__fallback__', preferred);
  }

  return identities;
}

/**
 * Dismiss our own earlier "changes requested" once the problems are gone.
 *
 * Without this the first blocking run keeps the PR red forever, since GitHub only
 * clears the state when the review that set it is dismissed.
 */
async function dismissStaleRequestChanges(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
  logger: Logger,
): Promise<void> {
  try {
    const reviews = await client.paginate<{ id: number; state: string; body?: string }>(
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
    );
    const stale = reviews.filter(
      (review) => review.state === 'CHANGES_REQUESTED' && (review.body ?? '').includes(MARKER_PREFIX),
    );
    for (const review of stale) {
      await client.request('PUT', `/repos/${owner}/${repo}/pulls/${number}/reviews/${review.id}/dismissals`, {
        message: '후속 커밋에서 차단 사유가 해소되어 자동 해제되었습니다. (review-swarm)',
        event: 'DISMISS',
      });
      logger.info(`dismissed stale CHANGES_REQUESTED review ${review.id}`);
    }
  } catch (error) {
    logger.warn(`could not dismiss stale reviews: ${String(error)}`);
  }
}
