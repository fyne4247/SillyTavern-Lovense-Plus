import { CHANNELS, mirroredLevel } from './channels.js';

// Channels other than the main vibrator. A pattern "relies" on one of these
// when it drives that channel on its own, rather than copying the vibration.
const SPECIAL_CHANNELS = Object.keys(CHANNELS).filter((channel) => channel !== 'vibrate');
// A short poke is still a vibration pattern. A feature is load-bearing when it
// does its own thing for a few seconds, or for a fifth of the pattern.
const SPECIAL_MIN_MS = 3000;
const SPECIAL_MIN_FRACTION = 0.2;

/**
 * Channels whose own shape the pattern depends on.
 * Copying the vibration (or leaving the channel out) does not count: a
 * vibrator-only toy still plays that pattern. Call-and-answer between two
 * motors, or thrust that moves separately from the vibe, does.
 * @param {{steps?: Array<Record<string, number>>}} pattern
 * @returns {string[]}
 */
export function requiredChannels(pattern) {
    const steps = Array.isArray(pattern?.steps) ? pattern.steps : [];
    const total = steps.reduce((sum, step) => sum + (step.ms || 0), 0);
    if (!total) return [];
    const used = new Map();
    for (const step of steps) {
        const vibe = step.vibrate ?? 0;
        for (const channel of SPECIAL_CHANNELS) {
            if (typeof step[channel] !== 'number') continue;
            if (step[channel] === mirroredLevel(channel, vibe)) continue;
            used.set(channel, (used.get(channel) || 0) + (step.ms || 0));
        }
    }
    return [...used.entries()]
        .filter(([, ms]) => ms >= SPECIAL_MIN_MS || ms / total >= SPECIAL_MIN_FRACTION)
        .map(([channel]) => channel);
}

/**
 * True when every feature this pattern relies on is in `channels`.
 * Pass null to skip the check (filter off, or no toy connected yet).
 * @param {object} pattern
 * @param {Iterable<string>|null|undefined} channels
 */
export function patternFitsChannels(pattern, channels) {
    if (!channels) return true;
    const have = new Set(channels);
    return requiredChannels(pattern).every((channel) => have.has(channel));
}

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
     * With minMs/maxMs, each mood only keeps patterns whose one pass is inside
     * that range. 0 on either side means that side is open.
     * With channels, patterns that rely on a missing feature are dropped.
     * Moods left with none are dropped. The stored library is not modified.
     * @param {Record<string, boolean>} [enabledMap]
     * @param {number} [maxMs] 0 means no maximum
     * @param {Iterable<string>|null} [channels] null means don't filter by feature
     * @param {number} [minMs] 0 means no minimum
     */
    enabledMoods(enabledMap = {}, maxMs = 0, channels = null, minMs = 0) {
        const on = [...this.moods.values()].filter((m) => enabledMap[m.mood] !== false);
        if (!maxMs && !minMs && !channels) return on;
        return on
            .map((m) => {
                let patterns = m.patterns;
                if (minMs || maxMs) patterns = patterns.filter((p) => lengthInRange(p, minMs, maxMs));
                if (channels) patterns = patterns.filter((p) => patternFitsChannels(p, channels));
                return patterns === m.patterns ? m : { ...m, patterns };
            })
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

/** True when one pass sits inside an open-ended range. 0 leaves that side open. */
export function lengthInRange(pattern, minMs = 0, maxMs = 0) {
    const length = patternLength(pattern);
    if (minMs && length < minMs) return false;
    if (maxMs && length > maxMs) return false;
    return true;
}

/**
 * If a minimum sits above a real maximum, move the side the user did not
 * just change. 0 on either side means that side is open and nothing moves.
 * @param {number|string} minSec
 * @param {number|string} maxSec
 * @param {'min'|'max'} changed
 * @returns {{ min: number, max: number }}
 */
export function reconcileLengthSecs(minSec, maxSec, changed) {
    const min = Math.max(0, Number(minSec) || 0);
    const max = Math.max(0, Number(maxSec) || 0);
    if (!min || !max || min <= max) return { min, max };
    return changed === 'min' ? { min, max: min } : { min: max, max };
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
