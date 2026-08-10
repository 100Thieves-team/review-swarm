import { normalizePath } from "../util/text.js";
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
/**
 * Parse a unified diff produced by `git diff`.
 *
 * Only the facts the harness needs are extracted: which lines exist on each side
 * of the diff (that is what GitHub's review API will accept as an anchor) and
 * which of those the PR actually touched.
 */
export function parseUnifiedDiff(diff) {
    const files = new Map();
    const lines = diff.split('\n');
    let current = null;
    let hunk = null;
    let oldLine = 0;
    let newLine = 0;
    // A hunk consumes exactly the line counts in its header; anything after that
    // (trailing blank lines, stray output) must not be mistaken for context.
    let oldRemaining = 0;
    let newRemaining = 0;
    let pendingOldPath = null;
    let pendingNewPath = null;
    for (const raw of lines) {
        if (raw.startsWith('diff --git ')) {
            if (current)
                files.set(current.path, current);
            const match = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/.exec(raw);
            pendingOldPath = match?.[1] ? normalizePath(match[1]) : null;
            pendingNewPath = match?.[2] ? normalizePath(match[2]) : null;
            current = {
                path: pendingNewPath ?? pendingOldPath ?? 'unknown',
                oldPath: pendingOldPath,
                status: 'modified',
                hunks: [],
                additions: 0,
                deletions: 0,
                rightLines: new Set(),
                leftLines: new Set(),
                addedLines: new Set(),
                removedLines: new Set(),
            };
            hunk = null;
            continue;
        }
        const file = current;
        if (!file)
            continue;
        if (raw.startsWith('new file mode')) {
            file.status = 'added';
            file.oldPath = null;
            continue;
        }
        if (raw.startsWith('deleted file mode')) {
            file.status = 'deleted';
            // The reviewable path for a deletion is the old path.
            if (pendingOldPath)
                file.path = pendingOldPath;
            continue;
        }
        if (raw.startsWith('rename from ')) {
            file.oldPath = normalizePath(raw.slice('rename from '.length));
            file.status = 'renamed';
            continue;
        }
        if (raw.startsWith('rename to ')) {
            file.path = normalizePath(raw.slice('rename to '.length));
            file.status = 'renamed';
            continue;
        }
        if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
            file.status = 'binary';
            continue;
        }
        if (raw.startsWith('--- ')) {
            if (raw.slice(4).trim() === '/dev/null') {
                file.status = 'added';
                file.oldPath = null;
            }
            continue;
        }
        if (raw.startsWith('+++ ')) {
            if (raw.slice(4).trim() === '/dev/null')
                file.status = 'deleted';
            continue;
        }
        const hunkMatch = HUNK_RE.exec(raw);
        if (hunkMatch) {
            const parsedHunk = {
                oldStart: Number.parseInt(hunkMatch[1] ?? '0', 10),
                oldLines: hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10),
                newStart: Number.parseInt(hunkMatch[3] ?? '0', 10),
                newLines: hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10),
                header: (hunkMatch[5] ?? '').trim(),
                lines: [],
            };
            hunk = parsedHunk;
            file.hunks.push(parsedHunk);
            oldLine = parsedHunk.oldStart;
            newLine = parsedHunk.newStart;
            oldRemaining = parsedHunk.oldLines;
            newRemaining = parsedHunk.newLines;
            continue;
        }
        const activeHunk = hunk;
        if (!activeHunk)
            continue;
        // "\ No newline at end of file" annotates the previous line, consumes none.
        if (raw.startsWith('\\')) {
            activeHunk.lines.push(raw);
            continue;
        }
        const marker = raw[0];
        if (marker === '+' && newRemaining > 0) {
            activeHunk.lines.push(raw);
            file.rightLines.add(newLine);
            file.addedLines.add(newLine);
            file.additions += 1;
            newLine += 1;
            newRemaining -= 1;
        }
        else if (marker === '-' && oldRemaining > 0) {
            activeHunk.lines.push(raw);
            file.leftLines.add(oldLine);
            file.removedLines.add(oldLine);
            file.deletions += 1;
            oldLine += 1;
            oldRemaining -= 1;
        }
        else if ((marker === ' ' || raw === '') && oldRemaining > 0 && newRemaining > 0) {
            // Some tools strip the trailing space of an empty context line.
            activeHunk.lines.push(raw === '' ? ' ' : raw);
            file.rightLines.add(newLine);
            file.leftLines.add(oldLine);
            oldLine += 1;
            newLine += 1;
            oldRemaining -= 1;
            newRemaining -= 1;
        }
        // Any other prefix (e.g. "index ", trailing junk) is metadata; ignore it.
        if (oldRemaining <= 0 && newRemaining <= 0)
            hunk = null;
    }
    if (current)
        files.set(current.path, current);
    return { files };
}
export function changedFiles(parsed) {
    return [...parsed.files.values()].map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
    }));
}
export const DEFAULT_ANCHOR_OPTIONS = {
    maxSnapDistance: 20,
    allowMultiLine: true,
};
/**
 * Map a persona-reported location onto a line GitHub will accept.
 *
 * GitHub rejects a review comment whose line is not part of the diff with a 422
 * that fails the whole review, so anything that cannot be anchored is reported
 * in the summary instead of being posted inline.
 */
export function resolveAnchor(parsed, file, startLine, endLine, side, options = DEFAULT_ANCHOR_OPTIONS) {
    const path = normalizePath(file);
    const target = parsed.files.get(path) ?? findBySuffix(parsed, path);
    if (!target || target.status === 'binary')
        return null;
    const preferredSide = target.status === 'deleted' ? 'LEFT' : side;
    const order = preferredSide === 'LEFT' ? ['LEFT', 'RIGHT'] : ['RIGHT', 'LEFT'];
    for (const trySide of order) {
        const changed = trySide === 'RIGHT' ? target.addedLines : target.removedLines;
        const available = trySide === 'RIGHT' ? target.rightLines : target.leftLines;
        if (available.size === 0)
            continue;
        const wantedEnd = Math.max(startLine, endLine);
        const wantedStart = Math.min(startLine, endLine);
        // Prefer landing on a line the PR actually changed, then any diff line.
        const line = nearest(changed, wantedEnd) ?? nearest(available, wantedEnd);
        if (line === null)
            continue;
        const snappedBy = Math.abs(line - wantedEnd);
        if (snappedBy > options.maxSnapDistance)
            continue;
        let start = null;
        if (options.allowMultiLine && wantedStart < wantedEnd) {
            const candidate = nearest(available, wantedStart);
            if (candidate !== null && candidate < line && line - candidate <= 50)
                start = candidate;
        }
        return {
            path: target.path,
            line,
            side: trySide,
            startLine: start,
            startSide: start === null ? null : trySide,
            snappedBy,
        };
    }
    return null;
}
function nearest(lines, target) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of lines) {
        const distance = Math.abs(line - target);
        // Ties break downward so a comment lands on the start of a changed block.
        if (distance < bestDistance || (distance === bestDistance && best !== null && line < best)) {
            best = line;
            bestDistance = distance;
        }
    }
    return best;
}
/** Personas sometimes report `src/x.ts` for `packages/app/src/x.ts`. Accept a unique suffix match. */
function findBySuffix(parsed, path) {
    const matches = [...parsed.files.values()].filter((file) => file.path.endsWith(`/${path}`) || path.endsWith(`/${file.path}`));
    return matches.length === 1 ? matches[0] : null;
}
/** The diff for one file, reassembled — used to give a verifier a focused context. */
export function fileDiff(parsed, path) {
    const file = parsed.files.get(normalizePath(path));
    return file ? renderFile(file) : '';
}
function renderFile(file) {
    const parts = [
        `diff --git a/${file.oldPath ?? file.path} b/${file.path}`,
        `--- ${file.status === 'added' ? '/dev/null' : `a/${file.oldPath ?? file.path}`}`,
        `+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.path}`}`,
    ];
    if (file.status === 'binary')
        parts.push('Binary files differ');
    for (const hunk of file.hunks) {
        parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`.trimEnd());
        parts.push(...hunk.lines);
    }
    return parts.join('\n');
}
/** Reassemble a diff limited to `paths`, in the diff's original file order. */
export function renderDiff(parsed, paths) {
    const keep = paths ? new Set(paths.map(normalizePath)) : null;
    const parts = [];
    for (const file of parsed.files.values()) {
        if (keep && !keep.has(file.path))
            continue;
        parts.push(renderFile(file));
    }
    return parts.join('\n');
}
//# sourceMappingURL=diff.js.map