import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesGlob } from '../src/util/glob.ts';
import { asEnum, asInt, asNumber, extractJsonObject } from '../src/util/json.ts';
import { fence, normalizePath, similarity, truncateTail } from '../src/util/text.ts';

describe('matchesGlob', () => {
  it('matches ** across segments and zero segments', () => {
    assert.equal(matchesGlob('src/repository/UserRepository.ts', '**/repository/**'), true);
    assert.equal(matchesGlob('repository/User.ts', '**/repository/**'), true);
    assert.equal(matchesGlob('src/service/User.ts', '**/repository/**'), false);
  });

  it('keeps * inside a single segment', () => {
    assert.equal(matchesGlob('src/UserService.ts', '**/*Service.*'), true);
    assert.equal(matchesGlob('src/a/b/UserService.ts', 'src/*Service.ts'), false);
  });

  it('expands brace alternation', () => {
    assert.equal(matchesGlob('deploy/app.yaml', '**/*.{yaml,yml}'), true);
    assert.equal(matchesGlob('deploy/app.yml', '**/*.{yaml,yml}'), true);
    assert.equal(matchesGlob('deploy/app.json', '**/*.{yaml,yml}'), false);
  });

  it('treats dots literally', () => {
    assert.equal(matchesGlob('srcXapp.ts', 'src/*.ts'), false);
  });
});

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  });

  it('prefers the last fenced block', () => {
    const text = 'draft:\n```json\n{"a":1}\n```\nfinal:\n```json\n{"a":2}\n```';
    assert.deepEqual(extractJsonObject(text), { a: 2 });
  });

  it('finds a trailing object inside prose', () => {
    assert.deepEqual(extractJsonObject('여기 결과입니다.\n{"findings":[]}\n감사합니다.'), { findings: [] });
  });

  it('is not confused by braces inside strings', () => {
    assert.deepEqual(extractJsonObject('{"body":"use { and } here"}'), { body: 'use { and } here' });
  });

  it('returns null when there is nothing to parse', () => {
    assert.equal(extractJsonObject('no json at all'), null);
  });
});

describe('coercion', () => {
  it('accepts numbers written as strings', () => {
    assert.equal(asInt('42', 0), 42);
    assert.equal(asNumber('0.75', 0), 0.75);
    assert.equal(asInt('nope', 7), 7);
  });

  it('matches enums case-insensitively and falls back', () => {
    assert.equal(asEnum('HIGH', ['low', 'high'] as const, 'low'), 'high');
    assert.equal(asEnum('critical', ['low', 'high'] as const, 'low'), 'low');
  });
});

describe('text helpers', () => {
  it('normalizes diff paths', () => {
    assert.equal(normalizePath('a/src/app.ts'), 'src/app.ts');
    assert.equal(normalizePath('./src/app.ts'), 'src/app.ts');
    assert.equal(normalizePath('/src/app.ts'), 'src/app.ts');
  });

  it('scores wording similarity', () => {
    assert.ok(similarity('missing authorization check', 'authorization check is missing') > 0.7);
    assert.ok(similarity('n+1 query in loop', 'rename the variable') < 0.2);
  });

  it('grows the fence so payloads cannot escape', () => {
    const fenced = fence('```\ninner\n```');
    assert.ok(fenced.startsWith('````'));
  });

  it('keeps the tail of long output', () => {
    const kept = truncateTail('a'.repeat(50) + 'TAIL', 10);
    assert.ok(kept.endsWith('TAIL'));
    assert.ok(kept.length < 60);
  });
});
