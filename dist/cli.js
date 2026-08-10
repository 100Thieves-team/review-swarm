#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildRegistry } from "./agents/registry.js";
import { loadConfig } from "./config.js";
import { createEngine } from "./engine/index.js";
import { runReview } from "./orchestrator.js";
import { readAppCredentials } from "./publish/github.js";
import { run } from "./util/exec.js";
import { createLogger, setLogLevel } from "./util/logger.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = `review-swarm — 로컬 멀티에이전트 PR 리뷰

사용법:
  review-swarm review [옵션]     PR을 리뷰하고 GitHub에 게시한다
  review-swarm doctor [옵션]     실행 환경과 자격 설정을 점검한다
  review-swarm init [옵션]       대상 저장소에 설정 파일과 워크플로를 생성한다

review 옵션:
  --repo <owner/name>      대상 저장소 (기본: $GITHUB_REPOSITORY)
  --pr <number>            PR 번호 (기본: $GITHUB_EVENT_PATH의 payload)
  --workdir <path>         저장소 체크아웃 경로 (기본: $GITHUB_WORKSPACE 또는 cwd)
  --config <path>          설정 파일 경로 (기본: 저장소의 .review-swarm.yaml)
  --out <path>             실행 산출물 디렉터리 (기본: <workdir>/.review-swarm/<run>)
  --base <ref|sha>         diff 기준 커밋 재정의 (증분 리뷰용)
  --engine <claude|codex|mock>  모든 단계의 엔진을 강제로 지정
  --token <token>          GitHub 토큰 (기본: $GITHUB_TOKEN)
  --api-url <url>          GitHub API 주소 (GHES용)
  --dry-run                게시하지 않고 산출물만 남긴다
  --fail-on <never|request_changes>  종료 코드 정책 (기본: never)
  --log-level <debug|info|warn|error>

init 옵션:
  --workdir <path>         대상 저장소 (기본: cwd)
  --force                  기존 파일을 덮어쓴다
`;
async function main() {
    const argv = process.argv.slice(2);
    const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'review';
    const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
    if (command === 'help' || rest.includes('--help') || rest.includes('-h')) {
        process.stdout.write(USAGE);
        return 0;
    }
    const { values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            repo: { type: 'string' },
            pr: { type: 'string' },
            workdir: { type: 'string' },
            config: { type: 'string' },
            out: { type: 'string' },
            base: { type: 'string' },
            engine: { type: 'string' },
            token: { type: 'string' },
            'api-url': { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            'fail-on': { type: 'string', default: 'never' },
            'log-level': { type: 'string' },
            force: { type: 'boolean', default: false },
        },
    });
    if (values['log-level'])
        setLogLevel(values['log-level']);
    const logger = createLogger('swarm');
    const workdir = resolve(values.workdir ?? process.env.GITHUB_WORKSPACE ?? process.cwd());
    switch (command) {
        case 'review':
            return reviewCommand({ values, workdir, logger });
        case 'doctor':
            return doctorCommand({ workdir, configPath: values.config, logger });
        case 'init':
            return initCommand({ workdir, force: values.force === true, logger });
        default:
            process.stderr.write(`알 수 없는 명령: ${command}\n\n${USAGE}`);
            return 2;
    }
}
async function reviewCommand(args) {
    const { values, workdir, logger } = args;
    const repoSlug = values.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repoSlug || !repoSlug.includes('/')) {
        logger.error('--repo owner/name 또는 $GITHUB_REPOSITORY 가 필요합니다');
        return 2;
    }
    const [owner, repo] = repoSlug.split('/');
    const prNumber = resolvePrNumber(values.pr);
    if (!prNumber) {
        logger.error('--pr <number> 또는 pull_request 이벤트 payload가 필요합니다');
        return 2;
    }
    const token = values.token ??
        process.env.SWARM_GITHUB_TOKEN ??
        process.env.GITHUB_TOKEN ??
        process.env.GH_TOKEN ??
        null;
    const engineOverride = values.engine;
    if (engineOverride && !['claude', 'codex', 'mock'].includes(engineOverride)) {
        logger.error(`--engine 값이 잘못되었습니다: ${engineOverride}`);
        return 2;
    }
    const result = await runReview({
        owner,
        repo,
        prNumber,
        workdir,
        dryRun: values['dry-run'] === true,
        token,
        logger,
        ...(values.config ? { configPath: values.config } : {}),
        ...(values.out ? { outDir: values.out } : {}),
        ...(values.base ? { baseOverride: values.base } : {}),
        ...(engineOverride ? { engineOverride } : {}),
        ...(values['api-url'] ? { apiUrl: values['api-url'] } : {}),
    });
    const headline = `${result.outcome.event} · 인라인 ${result.outcome.inline.length}건 · 요약 ${result.outcome.summaryOnly.length}건 ` +
        `· 폐기 ${result.outcome.dropped.length}건 · ${Math.round(result.durationMs / 1000)}s`;
    logger.info(headline);
    writeStepSummary(result, headline);
    if (values['fail-on'] === 'request_changes' && result.outcome.event === 'REQUEST_CHANGES')
        return 1;
    return 0;
}
function resolvePrNumber(explicit) {
    if (explicit) {
        const parsed = Number.parseInt(explicit, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !existsSync(eventPath))
        return null;
    try {
        const payload = JSON.parse(readFileSync(eventPath, 'utf8'));
        const candidate = payload.pull_request?.number ?? payload.number ?? (payload.issue?.pull_request ? payload.issue.number : undefined);
        return typeof candidate === 'number' ? candidate : null;
    }
    catch {
        return null;
    }
}
function writeStepSummary(result, headline) {
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (!path)
        return;
    const lines = [
        `### review-swarm \`${result.runId}\``,
        '',
        headline,
        '',
        ...result.publish.posted.map((entry) => `- ${entry.identity}: ${entry.comments}건${entry.url ? ` — ${entry.url}` : ''}`),
        ...(result.publish.errors.length ? ['', '**오류**', ...result.publish.errors.map((e) => `- ${e}`)] : []),
        ...(result.degraded.length ? ['', '**부분 실패**', ...result.degraded.map((e) => `- ${e}`)] : []),
        '',
    ];
    try {
        appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    }
    catch {
        // A missing step summary must not fail the run.
    }
}
async function doctorCommand(args) {
    const { workdir, configPath, logger } = args;
    const problems = [];
    const report = (ok, message) => {
        process.stdout.write(`${ok ? '✅' : '❌'} ${message}\n`);
        if (!ok)
            problems.push(message);
    };
    const [major = 0] = process.versions.node.split('.').map(Number);
    report(major >= 20, `Node ${process.versions.node} (>=20 필요)`);
    const inGit = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workdir, timeoutMs: 15_000 });
    report(inGit.code === 0, `git 저장소: ${workdir}`);
    let config;
    try {
        const loaded = loadConfig(workdir, configPath);
        config = loaded.config;
        report(true, `설정: ${loaded.path ?? '내장 기본값'}`);
    }
    catch (error) {
        report(false, `설정 로드 실패: ${String(error)}`);
        return 1;
    }
    for (const name of ['claude', 'codex']) {
        const engine = createEngine(name, config);
        const ok = await engine.available();
        const isDefault = config.engine.default === name;
        report(ok || !isDefault, `엔진 \`${name}\`: ${ok ? '사용 가능' : '실행 불가'}${isDefault ? ' (기본 엔진)' : ''}`);
    }
    const token = process.env.SWARM_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    report(Boolean(token), 'GitHub 토큰 (GITHUB_TOKEN)');
    const registry = buildRegistry(config, workdir);
    if (config.publish.mode === 'apps') {
        for (const agent of registry.values()) {
            const credentials = readAppCredentials(agent.appEnvPrefix);
            process.stdout.write(`${credentials ? '✅' : '➖'} GitHub App \`${agent.id}\` (${agent.appEnvPrefix}_APP_ID / _PRIVATE_KEY)${credentials ? '' : ' — 미설정, 공용 토큰으로 게시됩니다'}\n`);
        }
    }
    logger.info(problems.length === 0 ? '점검 통과' : `${problems.length}건의 문제가 있습니다`);
    return problems.length === 0 ? 0 : 1;
}
async function initCommand(args) {
    const { workdir, force, logger } = args;
    const files = [
        { target: '.review-swarm.yaml', source: join(HERE, '..', 'review-swarm.example.yaml') },
        { target: '.github/workflows/review-swarm.yml', source: join(HERE, '..', 'templates', 'pr-review.yml') },
    ];
    for (const file of files) {
        const target = resolve(workdir, file.target);
        if (existsSync(target) && !force) {
            logger.warn(`건너뜀 (이미 존재): ${file.target} — 덮어쓰려면 --force`);
            continue;
        }
        if (!existsSync(file.source)) {
            logger.error(`템플릿을 찾을 수 없습니다: ${file.source}`);
            return 1;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(file.source, 'utf8'), 'utf8');
        logger.info(`생성: ${file.target}`);
    }
    const gitignore = resolve(workdir, '.gitignore');
    const entry = '.review-swarm/';
    const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (!current.split('\n').some((line) => line.trim() === entry)) {
        writeFileSync(gitignore, `${current}${current.endsWith('\n') || !current ? '' : '\n'}\n# review-swarm run artefacts\n${entry}\n`, 'utf8');
        logger.info('.gitignore에 .review-swarm/ 추가');
    }
    logger.info('다음 단계: README의 "GitHub App 만들기"를 따라 각 에이전트 App을 등록하세요.');
    return 0;
}
main()
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    process.stderr.write(`review-swarm 실패: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map