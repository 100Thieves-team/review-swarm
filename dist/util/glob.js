/**
 * Minimal glob matcher for repo-relative paths.
 *
 * Supports `**`, `*`, `?`, `{a,b}` and literal text — enough for router rules and
 * ignore lists, and small enough that the tool stays dependency-light.
 */
const cache = new Map();
export function globToRegExp(pattern) {
    const cached = cache.get(pattern);
    if (cached)
        return cached;
    let out = '^';
    let i = 0;
    const braces = [];
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            const isDouble = pattern[i + 1] === '*';
            if (isDouble) {
                const followedBySlash = pattern[i + 2] === '/';
                if (followedBySlash) {
                    // `**/` also matches zero segments, so `**/x.ts` matches `x.ts`.
                    out += '(?:.*/)?';
                    i += 3;
                }
                else {
                    out += '.*';
                    i += 2;
                }
            }
            else {
                out += '[^/]*';
                i += 1;
            }
            continue;
        }
        if (ch === '?') {
            out += '[^/]';
            i += 1;
            continue;
        }
        if (ch === '{') {
            braces.push(i);
            out += '(?:';
            i += 1;
            continue;
        }
        if (ch === '}' && braces.length > 0) {
            braces.pop();
            out += ')';
            i += 1;
            continue;
        }
        if (ch === ',' && braces.length > 0) {
            out += '|';
            i += 1;
            continue;
        }
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i += 1;
    }
    out += '$';
    const regex = new RegExp(out, 'i');
    cache.set(pattern, regex);
    return regex;
}
export function matchesGlob(path, pattern) {
    return globToRegExp(pattern).test(path);
}
export function matchesAnyGlob(path, patterns) {
    return patterns.some((pattern) => matchesGlob(path, pattern));
}
//# sourceMappingURL=glob.js.map