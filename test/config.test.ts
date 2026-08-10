import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { agentClass, loadConfig, normalize, DEFAULT_CONFIG } from '../src/config.ts';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function repoWith(configBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-config-'));
  scratch.push(dir);
  writeFileSync(join(dir, '.review-swarm.yaml'), configBody, 'utf8');
  return dir;
}

describe('loadConfig', () => {
  it('falls back to built-in defaults when no file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-config-'));
    scratch.push(dir);
    const { config, path } = loadConfig(dir);
    assert.equal(path, null);
    assert.equal(config.engine.default, 'claude');
  });

  it('merges nested overrides and replaces arrays wholesale', () => {
    const dir = repoWith(`
engine:
  default: codex
policy:
  maxInlineTotal: 5
router:
  always: [consistency]
`);
    const { config } = loadConfig(dir);
    assert.equal(config.engine.default, 'codex');
    assert.equal(config.engine.claude.bin, 'claude', 'untouched defaults survive');
    assert.equal(config.policy.maxInlineTotal, 5);
    assert.deepEqual(config.router.always, ['consistency'], 'arrays replace, never append');
  });

  it('fills in check defaults so a partial entry cannot misbehave', () => {
    const dir = repoWith(`
checks:
  - run: npm test
`);
    const { config } = loadConfig(dir);
    assert.deepEqual(config.checks[0], {
      name: 'check-1',
      run: 'npm test',
      timeoutMs: 600_000,
      maxOutputChars: 8_000,
    });
  });

  it('rejects a check with no command', () => {
    const dir = repoWith('checks:\n  - name: broken\n');
    assert.throws(() => loadConfig(dir), /needs a "run" command/);
  });

  it('rejects a router rule pointing at an unknown agent', () => {
    const dir = repoWith(`
router:
  rules:
    - name: bogus
      paths: ['**/*.ts']
      content: []
      add: [nonexistent]
`);
    assert.throws(() => loadConfig(dir), /unknown agent "nonexistent"/);
  });

  it('rejects an invalid publish mode', () => {
    const dir = repoWith('publish:\n  mode: shout\n');
    assert.throws(() => loadConfig(dir), /publish.mode must be/);
  });

  it('clamps nonsensical numbers instead of trusting them', () => {
    const config = normalize({
      ...structuredClone(DEFAULT_CONFIG),
      engine: { ...structuredClone(DEFAULT_CONFIG.engine), concurrency: 0, retries: -3 },
      verify: { ...DEFAULT_CONFIG.verify, voters: 0 },
    });
    assert.equal(config.engine.concurrency, 1);
    assert.equal(config.engine.retries, 0);
    assert.equal(config.verify.voters, 1);
  });
});

describe('agentClass', () => {
  it('reflects the configured authority tiers', () => {
    const config = normalize(structuredClone(DEFAULT_CONFIG));
    assert.equal(agentClass(config, 'security'), 'gate');
    assert.equal(agentClass(config, 'consistency'), 'gate');
    assert.equal(agentClass(config, 'performance'), 'analyst');
    assert.equal(agentClass(config, 'architect'), 'value');
    assert.equal(agentClass(config, 'mediator'), 'mediator');
  });
});
