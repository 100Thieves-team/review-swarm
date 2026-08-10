import type { AgentDefinition } from '../agents/registry.ts';
import type { SwarmConfig } from '../config.ts';
import type { ChangedFile } from '../types.ts';
import { matchesAnyGlob } from '../util/glob.ts';

export interface RoutingDecision {
  selected: string[];
  /** Why each persona was picked — surfaced in the summary so routing is auditable. */
  reasons: Map<string, string[]>;
  fullSweep: boolean;
}

const CLASS_PRIORITY: Record<AgentDefinition['klass'], number> = {
  gate: 0,
  analyst: 1,
  value: 2,
  mediator: 3,
};

/**
 * Pick the experts a change actually needs.
 *
 * Deterministic on purpose: routing decides what the run costs, so it has to be
 * reproducible and reviewable rather than another model call.
 */
export function route(
  config: SwarmConfig,
  registry: Map<string, AgentDefinition>,
  changedFiles: ChangedFile[],
  diff: string,
): RoutingDecision {
  const reasons = new Map<string, string[]>();
  const add = (agentId: string, reason: string) => {
    if (!registry.has(agentId)) return;
    if (registry.get(agentId)?.klass === 'mediator') return;
    const existing = reasons.get(agentId);
    if (existing) {
      if (!existing.includes(reason)) existing.push(reason);
    } else {
      reasons.set(agentId, [reason]);
    }
  };

  for (const agentId of config.router.always) add(agentId, 'always');

  const paths = changedFiles.map((file) => file.path);
  const touched = touchedText(diff).toLowerCase();

  for (const rule of config.router.rules) {
    const pathHit = rule.paths.length > 0 && paths.some((path) => matchesAnyGlob(path, rule.paths));
    const contentHit = rule.content.length > 0 && rule.content.some((token) => touched.includes(token.toLowerCase()));
    if (!pathHit && !contentHit) continue;
    const why = pathHit && contentHit ? `${rule.name} (경로+내용)` : pathHit ? `${rule.name} (경로)` : `${rule.name} (내용)`;
    for (const agentId of rule.add) add(agentId, why);
  }

  const changedLines = changedFiles.reduce((total, file) => total + file.additions + file.deletions, 0);
  const fullSweep = changedLines >= config.router.fullSweepChangedLines;
  if (fullSweep) {
    for (const agent of registry.values()) {
      if (agent.klass !== 'mediator') add(agent.id, `대형 변경(${changedLines}줄)`);
    }
  }

  // Nothing matched — a change still deserves at least the safety gates.
  if (reasons.size === 0) {
    for (const agent of registry.values()) {
      if (agent.klass === 'gate') add(agent.id, 'fallback');
    }
  }

  const ranked = [...reasons.keys()].sort((a, b) => {
    const agentA = registry.get(a);
    const agentB = registry.get(b);
    const classDelta = CLASS_PRIORITY[agentA?.klass ?? 'value'] - CLASS_PRIORITY[agentB?.klass ?? 'value'];
    if (classDelta !== 0) return classDelta;
    const hitDelta = (reasons.get(b)?.length ?? 0) - (reasons.get(a)?.length ?? 0);
    if (hitDelta !== 0) return hitDelta;
    return a.localeCompare(b);
  });

  const selected = ranked.slice(0, config.router.maxAgents);
  for (const dropped of ranked.slice(config.router.maxAgents)) reasons.delete(dropped);

  return { selected, reasons, fullSweep };
}

/** Only the added/removed lines — context lines would make every rule fire. */
function touchedText(diff: string): string {
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) out.push(line.slice(1));
  }
  return out.join('\n');
}
