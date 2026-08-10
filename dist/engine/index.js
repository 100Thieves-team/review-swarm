import { createClaudeEngine } from "./claude.js";
import { createCodexEngine } from "./codex.js";
import { createMockEngine } from "./mock.js";
export function createEngine(name, config) {
    switch (name) {
        case 'claude':
            return createClaudeEngine(config.engine.claude);
        case 'codex':
            return createCodexEngine(config.engine.codex);
        case 'mock':
            return createMockEngine();
        default: {
            const exhaustive = name;
            throw new Error(`unknown engine: ${String(exhaustive)}`);
        }
    }
}
/** Engine registry that reuses one instance per engine name. */
export class EnginePool {
    engines = new Map();
    config;
    constructor(config) {
        this.config = config;
    }
    get(name) {
        const existing = this.engines.get(name);
        if (existing)
            return existing;
        const engine = createEngine(name, this.config);
        this.engines.set(name, engine);
        return engine;
    }
    /** Engine + model + timeout for a stage, honouring per-stage overrides. */
    resolve(override) {
        const name = override?.engine ?? this.config.engine.default;
        return {
            engine: this.get(name),
            model: override?.model,
            timeoutMs: override?.timeoutMs ?? this.config.engine.timeoutMs,
        };
    }
}
//# sourceMappingURL=index.js.map