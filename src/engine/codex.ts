import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexEngineConfig } from '../config.ts';
import { run } from '../util/exec.ts';
import { extractJsonObject } from '../util/json.ts';
import type { Engine, EngineRequest, EngineResponse } from './index.ts';

/**
 * Codex CLI in non-interactive mode, reusing the machine's existing ChatGPT/API auth.
 *
 * `--output-schema` constrains the final message and `-o` writes it to a file, so
 * the transcript on stdout never has to be parsed on the happy path.
 */
export function createCodexEngine(config: CodexEngineConfig): Engine {
  let availability: Promise<boolean> | null = null;

  return {
    name: 'codex',

    available() {
      availability ??= run(config.bin, ['--version'], { timeoutMs: 30_000 }).then((result) => result.code === 0);
      return availability;
    },

    async invoke(request: EngineRequest): Promise<EngineResponse> {
      const scratch = join(request.runDir, 'engine', `codex-${request.label}`);
      mkdirSync(scratch, { recursive: true });
      const schemaPath = join(scratch, 'schema.json');
      const outputPath = join(scratch, 'last-message.json');
      writeFileSync(schemaPath, JSON.stringify(request.schema, null, 2), 'utf8');
      rmSync(outputPath, { force: true });

      const args = [
        'exec',
        '--sandbox',
        config.sandbox,
        '--cd',
        request.cwd,
        '--skip-git-repo-check',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        '--color',
        'never',
      ];

      if (config.ephemeral) args.push('--ephemeral');

      const model = request.model ?? config.model;
      if (model) args.push('--model', model);

      // Codex defaults to xhigh reasoning, which is far slower than a review turn needs.
      const effort = request.effort ?? config.effort;
      if (effort) args.push('--config', `model_reasoning_effort="${effort}"`);

      for (const override of config.configOverrides) args.push('--config', override);
      args.push(...config.extraArgs);

      // Trailing "-" makes codex read the prompt from stdin.
      args.push('-');

      const result = await run(config.bin, args, {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        stdin: request.prompt,
      });

      if (result.timedOut) {
        return fail(`codex timed out after ${request.timeoutMs}ms`, result.stdout, result.durationMs);
      }

      let lastMessage = '';
      try {
        lastMessage = readFileSync(outputPath, 'utf8');
      } catch {
        lastMessage = '';
      }

      const parsed = extractJsonObject(lastMessage) ?? extractJsonObject(result.stdout);
      if (parsed) {
        return { ok: true, data: parsed, raw: lastMessage || result.stdout, error: null, durationMs: result.durationMs, costUsd: null };
      }

      if (result.code !== 0) {
        return fail(
          `codex exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 600)}`,
          result.stdout,
          result.durationMs,
        );
      }
      return fail('codex produced no parsable JSON', result.stdout, result.durationMs);
    },
  };
}

function fail(error: string, raw: string, durationMs: number): EngineResponse {
  return { ok: false, data: null, raw, error, durationMs, costUsd: null };
}
