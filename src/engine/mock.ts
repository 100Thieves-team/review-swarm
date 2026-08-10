import { asRecord } from '../util/json.ts';
import type { Engine, EngineRequest, EngineResponse } from './index.ts';

/**
 * Deterministic engine for tests and `--dry-run`.
 *
 * Returns the minimum object that satisfies whichever schema it was handed, so
 * the whole pipeline can be exercised without spending a single token.
 */
export function createMockEngine(): Engine {
  return {
    name: 'mock',
    async available() {
      return true;
    },
    async invoke(request: EngineRequest): Promise<EngineResponse> {
      return {
        ok: true,
        data: emptyFor(request.schema),
        raw: '[mock]',
        error: null,
        durationMs: 0,
        costUsd: 0,
      };
    },
  };
}

function emptyFor(schema: unknown): unknown {
  const record = asRecord(schema);
  const properties = asRecord(record?.['properties']);
  if (!properties) return {};

  const out: Record<string, unknown> = {};
  for (const [key, rawProperty] of Object.entries(properties)) {
    const property = asRecord(rawProperty);
    const type = property?.['type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('array')) out[key] = [];
    else if (types.includes('null')) out[key] = null;
    else if (types.includes('boolean')) out[key] = false;
    else if (types.includes('number') || types.includes('integer')) out[key] = 0;
    else if (types.includes('object')) out[key] = emptyFor(property);
    else out[key] = '';
  }
  return out;
}
