import type { EngineName, SwarmConfig, EngineOverride } from '../config.ts';
import { createClaudeEngine } from './claude.ts';
import { createCodexEngine } from './codex.ts';
import { createMockEngine } from './mock.ts';

export interface EngineRequest {
  /** Stable label used for log lines and per-call scratch filenames. */
  label: string;
  prompt: string;
  schema: unknown;
  cwd: string;
  runDir: string;
  timeoutMs: number;
  model?: string;
}

export interface EngineResponse {
  ok: boolean;
  data: unknown | null;
  raw: string;
  error: string | null;
  durationMs: number;
  costUsd: number | null;
}

export interface Engine {
  readonly name: EngineName;
  /** Whether the CLI is installed and authenticated enough to try. */
  available(): Promise<boolean>;
  invoke(request: EngineRequest): Promise<EngineResponse>;
}

export function createEngine(name: EngineName, config: SwarmConfig): Engine {
  switch (name) {
    case 'claude':
      return createClaudeEngine(config.engine.claude);
    case 'codex':
      return createCodexEngine(config.engine.codex);
    case 'mock':
      return createMockEngine();
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown engine: ${String(exhaustive)}`);
    }
  }
}

/** Engine registry that reuses one instance per engine name. */
export class EnginePool {
  private readonly engines = new Map<EngineName, Engine>();
  private readonly config: SwarmConfig;

  constructor(config: SwarmConfig) {
    this.config = config;
  }

  get(name: EngineName): Engine {
    const existing = this.engines.get(name);
    if (existing) return existing;
    const engine = createEngine(name, this.config);
    this.engines.set(name, engine);
    return engine;
  }

  /** Engine + model + timeout for a stage, honouring per-stage overrides. */
  resolve(override: EngineOverride | undefined): { engine: Engine; model: string | undefined; timeoutMs: number } {
    const name = override?.engine ?? this.config.engine.default;
    return {
      engine: this.get(name),
      model: override?.model,
      timeoutMs: override?.timeoutMs ?? this.config.engine.timeoutMs,
    };
  }
}
