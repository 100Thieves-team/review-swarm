import { run } from "../util/exec.js";
import { asRecord, extractJsonObject } from "../util/json.js";
/**
 * Claude Code in headless mode, reusing whatever subscription/API auth the
 * machine already has.
 *
 * `--output-format json` wraps the turn in an envelope whose `structured_output`
 * field holds the schema-validated object, so the happy path needs no parsing of
 * model prose at all.
 */
export function createClaudeEngine(config) {
    let availability = null;
    return {
        name: 'claude',
        available() {
            availability ??= run(config.bin, ['--version'], { timeoutMs: 30_000 }).then((result) => result.code === 0);
            return availability;
        },
        async invoke(request) {
            const args = [
                '--print',
                '--output-format',
                'json',
                '--json-schema',
                JSON.stringify(request.schema),
                '--permission-mode',
                config.permissionMode,
                '--no-session-persistence',
                '--setting-sources',
                config.settingSources,
                '--add-dir',
                request.cwd,
                // The run directory holds the full patch, which may sit outside the repo.
                '--add-dir',
                request.runDir,
            ];
            // An empty tools list is meaningful: it disables every tool.
            args.push('--tools', config.tools.join(','));
            const model = request.model ?? config.model;
            if (model)
                args.push('--model', model);
            // Reasoning effort dominates wall-clock on exploratory review turns.
            const effort = request.effort ?? config.effort;
            if (effort)
                args.push('--effort', effort);
            args.push(...config.extraArgs);
            const result = await run(config.bin, args, {
                cwd: request.cwd,
                timeoutMs: request.timeoutMs,
                stdin: request.prompt,
                env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: '1' },
            });
            if (result.timedOut) {
                return fail(`claude timed out after ${request.timeoutMs}ms`, result.stdout, result.durationMs);
            }
            const envelope = asRecord(extractJsonObject(result.stdout));
            if (envelope) {
                const structured = envelope['structured_output'];
                if (structured !== undefined && structured !== null) {
                    return {
                        ok: true,
                        data: structured,
                        raw: result.stdout,
                        error: null,
                        durationMs: result.durationMs,
                        costUsd: typeof envelope['total_cost_usd'] === 'number' ? envelope['total_cost_usd'] : null,
                    };
                }
                const text = typeof envelope['result'] === 'string' ? envelope['result'] : '';
                const parsed = text ? extractJsonObject(text) : null;
                if (parsed) {
                    return {
                        ok: true,
                        data: parsed,
                        raw: result.stdout,
                        error: null,
                        durationMs: result.durationMs,
                        costUsd: typeof envelope['total_cost_usd'] === 'number' ? envelope['total_cost_usd'] : null,
                    };
                }
                const apiError = envelope['api_error_status'];
                const reason = envelope['is_error'] === true ? `claude reported an error: ${text.slice(0, 400)}` : null;
                return fail(reason ?? `claude returned no structured output${apiError ? ` (api status ${String(apiError)})` : ''}`, result.stdout, result.durationMs);
            }
            if (result.code !== 0) {
                return fail(`claude exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 600)}`, result.stdout, result.durationMs);
            }
            const loose = extractJsonObject(result.stdout);
            if (loose) {
                return { ok: true, data: loose, raw: result.stdout, error: null, durationMs: result.durationMs, costUsd: null };
            }
            return fail('claude produced no parsable JSON', result.stdout, result.durationMs);
        },
    };
}
function fail(error, raw, durationMs) {
    return { ok: false, data: null, raw, error, durationMs, costUsd: null };
}
//# sourceMappingURL=claude.js.map