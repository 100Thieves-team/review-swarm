import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { buildRegistry } from '../src/agents/registry.ts';
import { buildExpertPrompt } from '../src/pipeline/experts.ts';
import { testConfig } from './helpers.ts';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-knowledge-'));
  scratch.push(dir);
  for (const [relative, body] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body, 'utf8');
  }
  return dir;
}

describe('agent knowledge files', () => {
  it('loads knowledge into the configured agent only', () => {
    const dir = repoWith({ 'docs/k/security.md': '세션 토큰은 절대 로그에 남기지 않는다.' });
    const config = testConfig();
    config.agents['security'] = { ...config.agents['security']!, knowledgeFiles: ['docs/k/security.md'] };

    const registry = buildRegistry(config, dir);
    assert.match(registry.get('security')!.knowledge, /세션 토큰은 절대 로그에/);
    assert.equal(registry.get('performance')!.knowledge, '', 'other agents pay no context for it');
  });

  it('puts knowledge in the prompt, labelled as trusted but not a checklist', () => {
    const dir = repoWith({ 'docs/k/perf.md': '쿼리 수 변화만 근거로 인정한다.' });
    const config = testConfig();
    config.agents['performance'] = { ...config.agents['performance']!, knowledgeFiles: ['docs/k/perf.md'] };

    const registry = buildRegistry(config, dir);
    const prompt = buildExpertPrompt(registry.get('performance')!, '(blackboard)', config);
    assert.match(prompt, /쿼리 수 변화만 근거로 인정한다/);
    assert.match(prompt, /이 팀이 축적한 도메인 지식/);
    // Anchoring is the failure mode of injected checklists; the guard must ship with it.
    assert.match(prompt, /diff에 실제로 나타나지 않았다면 보고하지 마라/);
  });

  it('omits the whole section when an agent has no knowledge files', () => {
    const registry = buildRegistry(testConfig(), process.cwd());
    const prompt = buildExpertPrompt(registry.get('architect')!, '(blackboard)', testConfig());
    assert.equal(prompt.includes('이 팀이 축적한 도메인 지식'), false);
  });

  it('reports a missing knowledge file instead of silently dropping it', () => {
    const dir = repoWith({ 'README.md': 'x' });
    const config = testConfig();
    config.agents['security'] = { ...config.agents['security']!, knowledgeFiles: ['docs/k/gone.md'] };

    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn: (m: string) => warnings.push(m),
      error() {},
      child: () => logger,
    };

    const registry = buildRegistry(config, dir, logger);
    assert.equal(registry.get('security')!.knowledge, '');
    assert.ok(warnings.some((w) => w.includes('docs/k/gone.md')));
  });

  it('honours the per-agent character budget', () => {
    const dir = repoWith({ 'docs/k/big.md': 'A'.repeat(5_000) });
    const config = testConfig();
    config.context.maxAgentKnowledgeChars = 500;
    config.agents['security'] = { ...config.agents['security']!, knowledgeFiles: ['docs/k/big.md'] };

    const knowledge = buildRegistry(config, dir).get('security')!.knowledge;
    assert.ok(knowledge.includes('truncated'));
    assert.ok(knowledge.length < 900);
  });
});
