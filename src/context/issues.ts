import type { IssueTrackerConfig } from '../config.ts';
import type { LinkedIssue, PullRequestInfo } from '../types.ts';
import type { Logger } from '../util/logger.ts';
import { truncate } from '../util/text.ts';

/**
 * Issue keys mentioned by a PR, in first-seen order.
 *
 * Scans title, body and branch name because teams put the key in whichever of
 * those their tooling touches — here the branch is `moi-416-...` while the body
 * says `Fixes MOI-416`.
 */
export function extractIssueKeys(pr: PullRequestInfo, pattern: string, max: number): string[] {
  let regex: RegExp;
  try {
    // Case-sensitive on purpose: matching `utf-8` or `http-2` as issue keys would
    // send every run chasing issues that do not exist.
    regex = new RegExp(pattern, 'g');
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const add = (key: string) => {
    if (seen.size < max) seen.add(key.toUpperCase());
  };

  for (const source of [pr.title, pr.body]) {
    for (const match of source.matchAll(regex)) add(match[0]);
  }

  // Branch names are lowercased by tracker tooling (`moi-416-some-title`), so the
  // key is only trusted at the start of the last path segment — `fix-utf-8-x`
  // has no leading key and must not match.
  const segment = pr.headRef.split('/').pop() ?? '';
  const branchKey = /^([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![A-Za-z0-9])/.exec(segment);
  if (branchKey?.[1]) add(branchKey[1]);

  return [...seen];
}

interface LinearIssueResponse {
  issue?: {
    identifier?: string;
    title?: string;
    description?: string | null;
    url?: string;
    state?: { name?: string } | null;
  } | null;
}

const LINEAR_QUERY = `
query($id: String!){
  issue(id: $id){ identifier title description url state{ name } }
}`;

/**
 * Fetch linked issues for their acceptance criteria and out-of-scope notes.
 *
 * Entirely best-effort: no key, an unreachable API or an unknown key all degrade
 * to "no issue context" rather than failing the review. A review without intent
 * is worse than one with it, but far better than none.
 */
export async function fetchLinkedIssues(
  pr: PullRequestInfo,
  config: IssueTrackerConfig,
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LinkedIssue[]> {
  if (!config.enabled) return [];

  const keys = extractIssueKeys(pr, config.keyPattern, config.maxIssues);
  if (keys.length === 0) return [];

  const apiKey = env[config.apiKeyEnv]?.trim();
  if (!apiKey) {
    logger.warn(`이슈 ${keys.join(', ')}를 찾았지만 ${config.apiKeyEnv}가 없어 본문을 가져오지 못했습니다`);
    return [];
  }

  // Personal API keys are sent raw; OAuth access tokens need the Bearer scheme.
  const authorization = apiKey.startsWith('lin_api_') ? apiKey : `Bearer ${apiKey}`;
  const out: LinkedIssue[] = [];

  for (const key of keys) {
    try {
      const response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ query: LINEAR_QUERY, variables: { id: key } }),
      });
      if (!response.ok) {
        logger.warn(`Linear ${key} 조회 실패: HTTP ${response.status}`);
        continue;
      }

      const payload = (await response.json()) as { data?: LinearIssueResponse; errors?: unknown[] };
      if (payload.errors?.length) {
        logger.warn(`Linear ${key} 조회 오류: ${JSON.stringify(payload.errors).slice(0, 200)}`);
        continue;
      }

      const issue = payload.data?.issue;
      if (!issue?.identifier) continue;

      out.push({
        identifier: issue.identifier,
        title: issue.title ?? '',
        description: truncate((issue.description ?? '').trim(), config.maxCharsPerIssue),
        url: issue.url ?? '',
        state: issue.state?.name ?? 'unknown',
      });
    } catch (error) {
      logger.warn(`Linear ${key} 조회 실패: ${String(error)}`);
    }
  }

  if (out.length > 0) logger.info(`linked issues: ${out.map((issue) => issue.identifier).join(', ')}`);
  return out;
}
