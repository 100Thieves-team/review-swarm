/** Run thunks with a fixed concurrency cap, preserving input order in the result. */
export async function mapLimit(items, limit, worker) {
    const size = Math.max(1, Math.trunc(limit));
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length)
                return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}
/** Resolve to `fallback` if the promise has not settled within `ms`. */
export async function withTimeout(promise, ms, fallback) {
    if (ms <= 0)
        return promise;
    let timer;
    const guard = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
    });
    try {
        return await Promise.race([promise, guard]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=concurrency.js.map