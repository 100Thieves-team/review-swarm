import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { route } from '../src/pipeline/router.ts';
import type { ChangedFile } from '../src/types.ts';
import { testConfig, testRegistry } from './helpers.ts';

function file(path: string, additions = 5, deletions = 2): ChangedFile {
  return { path, oldPath: null, status: 'modified', additions, deletions };
}

describe('route', () => {
  const config = testConfig();
  const registry = testRegistry(config);

  it('always includes the configured baseline personas', () => {
    const decision = route(config, registry, [file('README.md')], '');
    assert.ok(decision.selected.includes('security'));
    assert.ok(decision.selected.includes('pragmatist'));
  });

  it('sends repository changes to performance and consistency', () => {
    const decision = route(config, registry, [file('src/repository/UserRepository.java')], '');
    assert.ok(decision.selected.includes('performance'));
    assert.ok(decision.selected.includes('consistency'));
    assert.match(decision.reasons.get('performance')?.join(' ') ?? '', /persistence/);
  });

  it('sends auth changes to security and collaborator', () => {
    const decision = route(config, registry, [file('src/auth/TokenFilter.kt')], '');
    assert.ok(decision.selected.includes('security'));
    assert.ok(decision.selected.includes('collaborator'));
  });

  it('fires content rules from added lines only', () => {
    const contextOnly = route(config, registry, [file('src/misc.ts')], ' @Transactional\n context line');
    assert.equal(contextOnly.selected.includes('consistency'), false);

    const added = route(config, registry, [file('src/misc.ts')], '+  @Transactional\n context line');
    assert.ok(added.selected.includes('consistency'));
  });

  it('does not keyword-scan the swarm config, which lists the triggers verbatim', () => {
    const configDiff = `diff --git a/.review-swarm.yaml b/.review-swarm.yaml
--- a/.review-swarm.yaml
+++ b/.review-swarm.yaml
@@ -1,1 +1,2 @@
 version: 1
+      content: ['@Transactional', jwt, token, secret, '@Query']
`;
    const decision = route(config, registry, [file('.review-swarm.yaml')], configDiff);
    assert.equal(decision.selected.includes('consistency'), false, 'transaction rule must not fire on its own config');
    assert.equal(decision.selected.includes('performance'), false);
    // The baseline personas still run; only the keyword fan-out is suppressed.
    assert.deepEqual(decision.selected.sort(), ['pragmatist', 'security']);
  });

  it('still keyword-scans real source files in the same diff', () => {
    const mixed = `diff --git a/.review-swarm.yaml b/.review-swarm.yaml
--- a/.review-swarm.yaml
+++ b/.review-swarm.yaml
@@ -1,1 +1,2 @@
 version: 1
+      content: ['@Transactional']
diff --git a/src/OrderService.kt b/src/OrderService.kt
--- a/src/OrderService.kt
+++ b/src/OrderService.kt
@@ -1,1 +1,2 @@
 class OrderService {
+  @Transactional fun save() {}
`;
    const decision = route(config, registry, [file('.review-swarm.yaml'), file('src/OrderService.kt')], mixed);
    assert.ok(decision.selected.includes('consistency'));
  });

  it('runs every persona on a large change', () => {
    const decision = route(config, registry, [file('src/app.ts', 500, 100)], '');
    assert.equal(decision.fullSweep, true);
    assert.equal(decision.selected.length, Math.min(6, config.router.maxAgents));
  });

  it('never routes to the mediator', () => {
    const decision = route(config, registry, [file('src/app.ts', 900, 900)], '');
    assert.equal(decision.selected.includes('mediator'), false);
  });

  it('caps the roster and keeps gates first', () => {
    const capped = testConfig({ router: { ...config.router, maxAgents: 2 } });
    const decision = route(capped, testRegistry(capped), [file('src/app.ts', 900, 900)], '');
    assert.equal(decision.selected.length, 2);
    assert.deepEqual(decision.selected.sort(), ['consistency', 'security']);
    assert.equal(decision.reasons.size, 2);
  });

  it('falls back to the safety gates when nothing matches', () => {
    const bare = testConfig({
      router: { always: [], rules: [], maxAgents: 6, fullSweepChangedLines: 10_000, contentScanIgnore: [] },
    });
    const decision = route(bare, testRegistry(bare), [file('notes.txt', 1, 0)], '');
    assert.deepEqual(decision.selected.sort(), ['consistency', 'security']);
  });
});
