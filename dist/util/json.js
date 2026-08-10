/**
 * Extract a JSON object from text that may also contain prose or fences.
 *
 * The engines are asked for schema-constrained output and usually comply, but a
 * degraded run (schema rejected, tool loop, provider hiccup) still has to yield
 * findings rather than an exception, so we scan for the last balanced object.
 */
export function extractJsonObject(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    const direct = tryParse(trimmed);
    if (direct !== undefined)
        return direct;
    // ```json fences, last one wins (agents often restate before finalising).
    const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
    for (let i = fences.length - 1; i >= 0; i -= 1) {
        const parsed = tryParse((fences[i]?.[1] ?? '').trim());
        if (parsed !== undefined)
            return parsed;
    }
    for (const candidate of balancedObjects(trimmed).reverse()) {
        const parsed = tryParse(candidate);
        if (parsed !== undefined)
            return parsed;
    }
    return null;
}
function tryParse(text) {
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** Every top-level `{...}` span, string- and escape-aware. */
function balancedObjects(text) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"')
            inString = true;
        else if (ch === '{') {
            if (depth === 0)
                start = i;
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                out.push(text.slice(start, i + 1));
                start = -1;
            }
            if (depth < 0)
                depth = 0;
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Lenient coercion. Model output is data from an unreliable source: coerce what
// is recoverable, drop what is not, never throw.
// ---------------------------------------------------------------------------
export function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
export function asArray(value) {
    return Array.isArray(value) ? value : [];
}
export function asString(value, fallback = '') {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return fallback;
}
export function asInt(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.trunc(value);
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value.trim(), 10);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
export function asNumber(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value.trim());
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
export function asBool(value, fallback) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(lowered))
            return true;
        if (['false', 'no', '0'].includes(lowered))
            return false;
    }
    return fallback;
}
export function asEnum(value, allowed, fallback) {
    const text = asString(value).trim().toLowerCase();
    const hit = allowed.find((option) => option.toLowerCase() === text);
    return hit ?? fallback;
}
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
//# sourceMappingURL=json.js.map