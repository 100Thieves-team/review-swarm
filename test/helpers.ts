import { buildRegistry, type AgentDefinition } from '../src/agents/registry.ts';
import { DEFAULT_CONFIG, normalize, type SwarmConfig } from '../src/config.ts';
import type { Finding, Severity, Verdict } from '../src/types.ts';

export function testConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return normalize({ ...structuredClone(DEFAULT_CONFIG), ...overrides } as SwarmConfig);
}

export function testRegistry(config: SwarmConfig = testConfig()): Map<string, AgentDefinition> {
  return buildRegistry(config, process.cwd());
}

let counter = 0;

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  counter += 1;
  const base: Finding = {
    id: `F${counter}`,
    file: 'src/app.ts',
    start_line: 10,
    end_line: 10,
    side: 'RIGHT',
    severity: 'medium' as Severity,
    confidence: 0.8,
    category: 'general',
    title: `finding ${counter}`,
    rationale: 'rationale',
    evidence: 'src/app.ts:10',
    scenario: 'scenario',
    suggested_fix: 'fix',
    suggestion_patch: null,
    agents: ['architect'],
    owner: 'architect',
    fingerprint: `fp${counter}`,
    anchor: { path: 'src/app.ts', line: 10, side: 'RIGHT', startLine: null, startSide: null, snappedBy: 0 },
    verification: null,
    debate: null,
    verdict: 'SUGGESTION' as Verdict,
    verdictReason: null,
    mergedBody: null,
  };
  return { ...base, ...overrides };
}

export const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -8,6 +8,8 @@ export class App {
   constructor(private readonly repo: Repo) {}

   async load(ids: string[]) {
-    return this.repo.findAll(ids);
+    const out = [];
+    for (const id of ids) out.push(await this.repo.findOne(id));
+    return out;
   }
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'hi';
+}
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const dead = true;
-
`;
