import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedFiles, parseUnifiedDiff, renderDiff, resolveAnchor } from '../src/context/diff.ts';
import { SAMPLE_DIFF } from './helpers.ts';

describe('parseUnifiedDiff', () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);

  it('records every file with its status', () => {
    assert.deepEqual([...parsed.files.keys()].sort(), ['src/app.ts', 'src/gone.ts', 'src/new.ts']);
    assert.equal(parsed.files.get('src/app.ts')?.status, 'modified');
    assert.equal(parsed.files.get('src/new.ts')?.status, 'added');
    assert.equal(parsed.files.get('src/gone.ts')?.status, 'deleted');
  });

  it('tracks new-file line numbers for added and context lines', () => {
    const file = parsed.files.get('src/app.ts');
    assert.ok(file);
    // Hunk starts at new line 8; three context lines, then the replacement block.
    assert.deepEqual([...file.addedLines].sort((a, b) => a - b), [11, 12, 13]);
    assert.equal(file.additions, 3);
    assert.equal(file.deletions, 1);
    assert.ok(file.rightLines.has(8));
    assert.ok(file.rightLines.has(14));
    assert.equal(file.rightLines.has(999), false);
  });

  it('tracks old-file line numbers for removals', () => {
    const file = parsed.files.get('src/app.ts');
    assert.ok(file);
    assert.deepEqual([...file.removedLines], [11]);
    assert.ok(file.leftLines.has(8));
  });

  it('counts a deleted file as deletions only', () => {
    const file = parsed.files.get('src/gone.ts');
    assert.ok(file);
    assert.equal(file.additions, 0);
    assert.equal(file.deletions, 2);
    assert.equal(file.rightLines.size, 0);
  });

  it('summarises changed files', () => {
    const summary = changedFiles(parsed);
    assert.equal(summary.length, 3);
    assert.deepEqual(
      summary.find((file) => file.path === 'src/new.ts'),
      { path: 'src/new.ts', oldPath: null, status: 'added', additions: 3, deletions: 0 },
    );
  });

  it('round-trips through renderDiff', () => {
    const rendered = renderDiff(parsed, ['src/app.ts']);
    const reparsed = parseUnifiedDiff(rendered);
    assert.deepEqual([...reparsed.files.keys()], ['src/app.ts']);
    assert.deepEqual(
      [...(reparsed.files.get('src/app.ts')?.addedLines ?? [])].sort((a, b) => a - b),
      [11, 12, 13],
    );
  });

  it('handles renames', () => {
    const renamed = parseUnifiedDiff(`diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
 keep
-old
+new
`);
    const file = renamed.files.get('new/name.ts');
    assert.ok(file);
    assert.equal(file.status, 'renamed');
    assert.equal(file.oldPath, 'old/name.ts');
    assert.deepEqual([...file.addedLines], [2]);
  });

  it('ignores an empty diff', () => {
    assert.equal(parseUnifiedDiff('').files.size, 0);
  });
});

describe('resolveAnchor', () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);

  it('anchors a changed line exactly', () => {
    const anchor = resolveAnchor(parsed, 'src/app.ts', 12, 12, 'RIGHT');
    assert.deepEqual(anchor, {
      path: 'src/app.ts',
      line: 12,
      side: 'RIGHT',
      startLine: null,
      startSide: null,
      snappedBy: 0,
    });
  });

  it('builds a multi-line anchor when both ends are in the diff', () => {
    const anchor = resolveAnchor(parsed, 'src/app.ts', 11, 13, 'RIGHT');
    assert.equal(anchor?.line, 13);
    assert.equal(anchor?.startLine, 11);
    assert.equal(anchor?.startSide, 'RIGHT');
  });

  it('snaps a nearby line onto the closest changed line', () => {
    const anchor = resolveAnchor(parsed, 'src/app.ts', 16, 16, 'RIGHT');
    assert.equal(anchor?.line, 13);
    assert.equal(anchor?.snappedBy, 3);
  });

  it('refuses to snap beyond the configured distance', () => {
    const anchor = resolveAnchor(parsed, 'src/app.ts', 400, 400, 'RIGHT', {
      maxSnapDistance: 5,
      allowMultiLine: true,
    });
    assert.equal(anchor, null);
  });

  it('falls back to LEFT for a deleted file even when RIGHT was requested', () => {
    const anchor = resolveAnchor(parsed, 'src/gone.ts', 1, 1, 'RIGHT');
    assert.equal(anchor?.side, 'LEFT');
    assert.equal(anchor?.line, 1);
  });

  it('returns null for a file outside the diff', () => {
    assert.equal(resolveAnchor(parsed, 'src/absent.ts', 1, 1, 'RIGHT'), null);
  });

  it('accepts a unique suffix match for a shortened path', () => {
    const anchor = resolveAnchor(parsed, 'app.ts', 12, 12, 'RIGHT');
    assert.equal(anchor?.path, 'src/app.ts');
  });

  it('normalizes a/ and b/ prefixes', () => {
    assert.equal(resolveAnchor(parsed, 'b/src/app.ts', 12, 12, 'RIGHT')?.path, 'src/app.ts');
  });
});
