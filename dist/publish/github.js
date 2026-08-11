import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sleep } from "../util/concurrency.js";
export const DEFAULT_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';
export class GitHubError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.name = 'GitHubError';
        this.status = status;
        this.body = body;
    }
}
export class GitHubClient {
    token;
    apiUrl;
    logger;
    constructor(token, apiUrl = DEFAULT_API_URL, logger) {
        this.token = token;
        this.apiUrl = apiUrl;
        this.logger = logger;
    }
    async request(method, path, body) {
        const url = path.startsWith('http') ? path : `${this.apiUrl}${path}`;
        for (let attempt = 0;; attempt += 1) {
            const response = await fetch(url, {
                method,
                headers: {
                    accept: 'application/vnd.github+json',
                    authorization: `Bearer ${this.token}`,
                    'content-type': 'application/json',
                    'x-github-api-version': '2022-11-28',
                    'user-agent': 'review-swarm',
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            const parsed = text ? safeJson(text) : null;
            if (response.ok)
                return parsed;
            const retryable = response.status >= 500 || response.status === 429 || isSecondaryRateLimit(response, parsed);
            if (retryable && attempt < 3) {
                const wait = retryAfter(response) ?? 2 ** attempt * 1000;
                this.logger?.warn(`GitHub ${response.status} on ${method} ${path}; retrying in ${wait}ms`);
                await sleep(wait);
                continue;
            }
            throw new GitHubError(`GitHub ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`, response.status, parsed);
        }
    }
    async paginate(path) {
        const out = [];
        let page = 1;
        for (;;) {
            const separator = path.includes('?') ? '&' : '?';
            const batch = await this.request('GET', `${path}${separator}per_page=100&page=${page}`);
            if (!Array.isArray(batch) || batch.length === 0)
                return out;
            out.push(...batch);
            if (batch.length < 100 || page >= 10)
                return out;
            page += 1;
        }
    }
    async graphql(query, variables) {
        const endpoint = this.apiUrl.replace(/\/$/, '').replace(/\/api\/v3$/, '/api') + '/graphql';
        const url = this.apiUrl === DEFAULT_API_URL ? 'https://api.github.com/graphql' : endpoint;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json',
                'user-agent': 'review-swarm',
            },
            body: JSON.stringify({ query, variables }),
        });
        const text = await response.text();
        const parsed = safeJson(text);
        if (!response.ok || parsed?.errors) {
            throw new GitHubError(`GitHub GraphQL failed: ${response.status} ${text.slice(0, 400)}`, response.status, parsed);
        }
        return parsed?.data;
    }
}
function safeJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function retryAfter(response) {
    const header = response.headers.get('retry-after');
    if (!header)
        return null;
    const seconds = Number.parseInt(header, 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
}
function isSecondaryRateLimit(response, body) {
    if (response.status !== 403)
        return false;
    const message = typeof body === 'object' && body !== null ? String(body.message ?? '') : '';
    return message.toLowerCase().includes('secondary rate limit');
}
// ---------------------------------------------------------------------------
// GitHub App authentication
// ---------------------------------------------------------------------------
function base64url(input) {
    return Buffer.from(input).toString('base64url');
}
/** Short-lived RS256 JWT identifying the app itself (not an installation). */
export function createAppJwt(appId, privateKeyPem) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // Backdate `iat` to tolerate clock skew between the runner and GitHub.
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem).toString('base64url');
    return `${header}.${payload}.${signature}`;
}
export function normalizePrivateKey(raw) {
    // Secrets stored in env often arrive with literal \n sequences.
    const key = raw.includes('-----BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    return key.replace(/\\n/g, '\n').trim();
}
/** Read `${prefix}_APP_ID` / `${prefix}_PRIVATE_KEY` (or `_PRIVATE_KEY_PATH`) from the environment. */
export function readAppCredentials(prefix, env = process.env) {
    const appId = env[`${prefix}_APP_ID`];
    const inlineKey = env[`${prefix}_PRIVATE_KEY`];
    const keyPath = env[`${prefix}_PRIVATE_KEY_PATH`];
    if (!appId)
        return null;
    let privateKey = null;
    if (inlineKey)
        privateKey = normalizePrivateKey(inlineKey);
    else if (keyPath) {
        try {
            privateKey = normalizePrivateKey(readFileSync(keyPath, 'utf8'));
        }
        catch {
            privateKey = null;
        }
    }
    if (!privateKey)
        return null;
    const installationId = env[`${prefix}_INSTALLATION_ID`];
    return installationId ? { appId, privateKey, installationId } : { appId, privateKey };
}
/** Exchange app credentials for an installation token scoped to one repository. */
export async function authenticateApp(credentials, owner, repo, apiUrl = DEFAULT_API_URL, logger) {
    const jwt = createAppJwt(credentials.appId, credentials.privateKey);
    const asApp = new GitHubClient(jwt, apiUrl, logger);
    const app = await asApp.request('GET', '/app');
    const installationId = credentials.installationId ??
        String((await asApp.request('GET', `/repos/${owner}/${repo}/installation`)).id);
    const created = await asApp.request('POST', `/app/installations/${installationId}/access_tokens`, { repositories: [repo] });
    return {
        token: created.token,
        slug: app.slug ?? null,
        name: app.name ?? app.slug ?? credentials.appId,
        source: 'app',
    };
}
export async function fetchPullRequest(client, owner, repo, number) {
    const pr = await client.request('GET', `/repos/${owner}/${repo}/pulls/${number}`);
    return {
        owner,
        repo,
        number,
        title: pr.title,
        body: pr.body ?? '',
        author: pr.user?.login ?? 'unknown',
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        isFork: (pr.head.repo?.full_name ?? `${owner}/${repo}`) !== `${owner}/${repo}`,
        htmlUrl: pr.html_url,
    };
}
/**
 * Submit a review, degrading rather than failing.
 *
 * GitHub rejects the entire review with a 422 when a single comment points at a
 * line outside the diff, so an unanchorable comment must never take the whole
 * review down with it.
 */
export async function createReview(client, owner, repo, number, payload, logger) {
    const path = `/repos/${owner}/${repo}/pulls/${number}/reviews`;
    try {
        const created = await client.request('POST', path, payload);
        return {
            ok: true,
            postedComments: payload.comments.length,
            droppedComments: 0,
            htmlUrl: created.html_url ?? null,
            error: null,
        };
    }
    catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 422 || payload.comments.length === 0) {
            return {
                ok: false,
                postedComments: 0,
                droppedComments: payload.comments.length,
                htmlUrl: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        logger?.warn(`review rejected (422); retrying without inline comments`);
        const rejected = payload.comments;
        const fallbackBody = `${payload.body}\n\n${renderRejectedComments(rejected)}`;
        try {
            const created = await client.request('POST', path, {
                commit_id: payload.commit_id,
                body: fallbackBody,
                event: payload.event,
                comments: [],
            });
            return {
                ok: true,
                postedComments: 0,
                droppedComments: rejected.length,
                htmlUrl: created.html_url ?? null,
                error: '인라인 앵커 실패로 본문에 통합됨',
            };
        }
        catch (fallbackError) {
            return {
                ok: false,
                postedComments: 0,
                droppedComments: rejected.length,
                htmlUrl: null,
                error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            };
        }
    }
}
function renderRejectedComments(comments) {
    const rendered = comments
        .map((comment) => `<details><summary><code>${comment.path}:${comment.line}</code></summary>\n\n${comment.body}\n\n</details>`)
        .join('\n\n');
    return `---\n\n> 아래 항목은 diff 라인에 인라인으로 고정할 수 없어 본문에 포함했습니다.\n\n${rendered}`;
}
export async function listReviewComments(client, owner, repo, number) {
    const raw = await client.paginate(`/repos/${owner}/${repo}/pulls/${number}/comments`);
    return raw.map((comment) => ({
        id: comment.id,
        nodeId: comment.node_id,
        body: comment.body ?? '',
        path: comment.path ?? null,
        line: comment.line ?? null,
        isMinimized: false,
    }));
}
export async function listIssueComments(client, owner, repo, number) {
    const raw = await client.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`);
    return raw.map((comment) => ({ id: comment.id, body: comment.body ?? '' }));
}
/** Create or update the single summary comment identified by `marker`. */
export async function upsertIssueComment(client, owner, repo, number, marker, body) {
    const existing = (await listIssueComments(client, owner, repo, number)).find((comment) => comment.body.includes(marker));
    if (existing) {
        await client.request('PATCH', `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
        return { id: existing.id, updated: true };
    }
    const created = await client.request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, {
        body,
    });
    return { id: created.id, updated: false };
}
const PRIOR_REVIEW_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          isResolved
          isOutdated
          path
          line
          comments(first:1){
            nodes{ body reactions(content: THUMBS_DOWN){ totalCount } }
          }
        }
      }
    }
  }
}`;
/**
 * What this swarm already said on this PR, and what the author closed.
 *
 * Resolving a thread or thumbs-downing a comment is the author saying "not doing
 * this" — the review must respect that instead of re-raising it on every push.
 * Best-effort: an unavailable GraphQL API degrades to "no history", never fails.
 */
export async function fetchPriorReview(client, owner, repo, number, parseMarker, parseTitle, logger) {
    let data;
    try {
        data = await client.graphql(PRIOR_REVIEW_QUERY, { owner, repo, number });
    }
    catch (error) {
        logger?.warn(`could not read prior review threads: ${String(error)}`);
        return [];
    }
    const out = [];
    for (const thread of data.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
        const comment = thread.comments?.nodes?.[0];
        const body = comment?.body ?? '';
        const marker = parseMarker(body);
        if (!marker)
            continue;
        out.push({
            fingerprint: marker.fingerprint,
            agent: marker.agent,
            title: parseTitle(body),
            path: thread.path,
            line: thread.line,
            dismissed: thread.isResolved || (comment?.reactions?.totalCount ?? 0) > 0,
            outdated: thread.isOutdated,
        });
    }
    return out;
}
/** Collapse a stale review comment. Best-effort: never fails the run. */
export async function minimizeComment(client, nodeId, logger) {
    try {
        await client.graphql(`mutation($id: ID!) {
        minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
          minimizedComment { isMinimized }
        }
      }`, { id: nodeId });
        return true;
    }
    catch (error) {
        logger?.debug(`minimizeComment failed for ${nodeId}: ${String(error)}`);
        return false;
    }
}
//# sourceMappingURL=github.js.map