/**
 * Loads the pattern library from patterns/index.json and the per-mood files.
 */
export class PatternLibrary {
    constructor() {
        /** @type {Map<string, {mood: string, label: string, description: string, keywords: string[], patterns: object[]}>} */
        this.moods = new Map();
        /** @type {Map<string, object>} */
        this.byId = new Map();
    }

    /**
     * @param {URL|string} baseUrl URL of the patterns/ directory (with trailing slash)
     * @param {typeof fetch} [fetchImpl]
     */
    async load(baseUrl, fetchImpl = fetch) {
        const index = await (await fetchImpl(new URL('index.json', baseUrl))).json();
        const files = await Promise.all(index.moods.map(async (mood) => {
            try {
                const res = await fetchImpl(new URL(`${mood}.json`, baseUrl));
                return await res.json();
            } catch (error) {
                console.warn(`[Lovense] Could not load patterns/${mood}.json`, error);
                return null;
            }
        }));
        this.moods.clear();
        this.byId.clear();
        for (const file of files) if (file) this.add(file);
        return this;
    }

    add(file) {
        for (const p of file.patterns) p.mood = file.mood;
        this.moods.set(file.mood, file);
        for (const p of file.patterns) this.byId.set(p.id, p);
    }

    get(id) {
        return this.byId.get(id) || null;
    }

    /**
     * Mood files that are switched on in settings (missing entries count as on).
     * With maxMs, each mood only keeps patterns whose single pass fits, and
     * moods left with none are dropped.
     */
    enabledMoods(enabledMap = {}, maxMs = 0) {
        const on = [...this.moods.values()].filter((m) => enabledMap[m.mood] !== false);
        if (!maxMs) return on;
        return on
            .map((m) => ({ ...m, patterns: m.patterns.filter((p) => patternLength(p) <= maxMs) }))
            .filter((m) => m.patterns.length > 0);
    }

    get size() {
        return this.byId.size;
    }
}

/** Length of one pass through a pattern, in milliseconds. */
export function patternLength(pattern) {
    return pattern.steps.reduce((total, step) => total + step.ms, 0);
}

/**
 * Pick a pattern from a mood, closest to the target energy, avoiding recent ones.
 * @param {{patterns: object[]}} mood
 * @param {number} energy Target 1-5
 * @param {string[]} recent Recently played pattern ids
 * @param {() => number} [random]
 */
export function pickFromMood(mood, energy, recent = [], random = Math.random) {
    const fresh = mood.patterns.filter((p) => !recent.includes(p.id));
    const pool = fresh.length ? fresh : mood.patterns;
    const ranked = [...pool].sort((a, b) => Math.abs(a.energy - energy) - Math.abs(b.energy - energy));
    const best = Math.abs(ranked[0].energy - energy);
    const close = ranked.filter((p) => Math.abs(p.energy - energy) <= best + 1).slice(0, 4);
    return close[Math.floor(random() * close.length)];
}
