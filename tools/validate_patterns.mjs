#!/usr/bin/env node
// Validate patterns/*.json against docs/PATTERN_FORMAT.md.
// Usage: node tools/validate_patterns.mjs [mood ...]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'patterns');

const CHANNELS = {
    vibrate: 20, vibrate2: 20, rotate: 20, pump: 3, thrust: 20,
    suction: 20, fingering: 20, oscillate: 20,
};
const TAGS = new Set(['slow', 'fast', 'light', 'heavy', 'build', 'drop', 'steady', 'random',
    'pulse', 'wave', 'burst', 'silence', 'long', 'short', 'motion', 'squeeze', 'dual']);

// Dual-motor toys are often worn as a pair. Whatever one motor gets, the other
// must get within this long, or the wearer is left lopsided.
const MOTOR_ECHO_MS = 5000;

// A level this low is silence for rating purposes. Bursts under this are not
// "intense", so a quiet mood of soft touches (tease, aftercare) stays on the mean.
const QUIET_AT = 2;
const BURST_FLOOR = 8;
// Spike-style moods are mostly quiet, the loud part is brief, and the hits
// themselves are strong. Denial and spikes qualify; a flat or gentle mood does not.
const SPIKE_QUIET_FRACTION = 0.55;
const SPIKE_BURST_FRACTION = 0.35;
const SPIKE_MIN_AVG_PEAK = 10;

/**
 * Longest time a motor is left owed a touch. When one motor runs alone, the
 * other is owed one, unless that solo run is itself answering an earlier one.
 * Checked across two passes so a looping pattern's wraparound counts too.
 */
function longestUnansweredMotor(steps) {
    const owedSince = { first: null, second: null };
    let t = 0;
    let worst = 0;
    const pay = (side) => {
        if (owedSince[side] !== null) worst = Math.max(worst, t - owedSince[side]);
        owedSince[side] = null;
    };
    for (const s of [...steps, ...steps]) {
        const first = s.vibrate > 0;
        const second = (s.vibrate2 ?? s.vibrate) > 0;
        if (first && second) {
            pay('first');
            pay('second');
        } else if (first) {
            if (owedSince.first !== null) pay('first');
            else if (owedSince.second === null) owedSince.second = t;
        } else if (second) {
            if (owedSince.second !== null) pay('second');
            else if (owedSince.first === null) owedSince.first = t;
        }
        t += s.ms;
    }
    for (const since of Object.values(owedSince)) if (since !== null) worst = Math.max(worst, t - since);
    return worst;
}

/** Louder of the two motors. An omitted vibrate2 copies vibrate at play time. */
function felt(step) {
    return Math.max(step.vibrate ?? 0, step.vibrate2 ?? 0);
}

/**
 * Time-weighted mean of `vibrate`, plus the peak a wearer actually gets.
 * @param {Array<{ms: number, vibrate: number, vibrate2?: number}>} steps
 */
export function patternIntensity(steps) {
    let sum = 0;
    let weighted = 0;
    let peak = 0;
    for (const s of steps) {
        if (!s || typeof s !== 'object') continue;
        const ms = Number.isInteger(s.ms) ? s.ms : 0;
        const v = Number.isInteger(s.vibrate) ? s.vibrate : 0;
        sum += ms;
        weighted += v * ms;
        peak = Math.max(peak, felt(s));
    }
    return { sum, avg: sum ? weighted / sum : 0, peak };
}

/**
 * True when a mood is mostly quiet with brief intense bursts.
 * Those patterns read as the hit, not as the silence around it, so energy
 * follows the peak. Stretched denial/spikes would otherwise all land on 1.
 * @param {Array<{steps?: object[]}>} patterns
 */
export function moodRatesByPeak(patterns) {
    let quiet = 0;
    let burst = 0;
    let sum = 0;
    let peakSum = 0;
    let n = 0;
    for (const p of patterns) {
        if (!Array.isArray(p.steps) || p.steps.length === 0) continue;
        const { sum: total, peak } = patternIntensity(p.steps);
        if (total <= 0) continue;
        const burstAt = Math.max(BURST_FLOOR, peak * 0.7);
        let quietMs = 0;
        let burstMs = 0;
        for (const s of p.steps) {
            if (!s || typeof s !== 'object') continue;
            const ms = Number.isInteger(s.ms) ? s.ms : 0;
            const level = felt(s);
            if (level <= QUIET_AT) quietMs += ms;
            if (level >= burstAt) burstMs += ms;
        }
        quiet += quietMs;
        burst += burstMs;
        sum += total;
        peakSum += peak;
        n++;
    }
    if (!n || sum <= 0) return false;
    return quiet / sum >= SPIKE_QUIET_FRACTION
        && burst / sum <= SPIKE_BURST_FRACTION
        && peakSum / n >= SPIKE_MIN_AVG_PEAK;
}

/** Energy 1–5 from a 0–20 level. Same buckets the mean rule has always used. */
function energyFromLevel(level) {
    return Math.min(5, Math.max(1, Math.round(level / 4) || 1));
}

/**
 * @param {Array<{ms: number, vibrate: number, vibrate2?: number}>} steps
 * @param {boolean} byPeak Rate a spike-style pattern by its peak instead of its mean
 */
export function suggestEnergy(steps, byPeak) {
    const { avg, peak } = patternIntensity(steps);
    return energyFromLevel(byPeak ? peak : avg);
}

function main() {
const only = new Set(process.argv.slice(2));
const errors = [];
const warnings = [];
const ids = new Map();
const names = new Map();
const shapes = new Map();
let total = 0;

const isInt = (v) => Number.isInteger(v);

// Shape fingerprint: normalized contour + rhythm, so scaled copies collide.
function shape(steps) {
    const max = Math.max(1, ...steps.map((s) => s.vibrate));
    const sum = steps.reduce((a, s) => a + s.ms, 0);
    return steps.map((s) => `${Math.round((s.vibrate / max) * 4)}:${Math.round((s.ms / sum) * 20)}`).join(',');
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
for (const file of files) {
    const mood = file.replace(/\.json$/, '');
    const report = only.size === 0 || only.has(mood);
    const err = (m) => report && errors.push(`${file}: ${m}`);
    const warn = (m) => report && warnings.push(`${file}: ${m}`);

    let data;
    try {
        data = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    } catch (e) {
        err(`invalid JSON: ${e.message}`);
        continue;
    }

    if (data.mood !== mood) err(`"mood" must be "${mood}"`);
    if (!/^[a-z_]+$/.test(mood)) err('file name must be lowercase a-z and _');
    if (typeof data.label !== 'string' || !data.label) err('missing "label"');
    if (typeof data.description !== 'string' || data.description.length < 20) err('"description" missing or too short');
    if (!Array.isArray(data.keywords) || data.keywords.length < 15 || data.keywords.length > 60) err('"keywords" must have 15-60 entries');
    else for (const k of data.keywords) if (typeof k !== 'string' || k !== k.toLowerCase() || !k.trim()) err(`bad keyword ${JSON.stringify(k)}`);
    if (!Array.isArray(data.patterns)) { err('"patterns" must be an array'); continue; }
    if (data.patterns.length < 12 || data.patterns.length > 48) err(`has ${data.patterns.length} patterns, need 12-48`);
    const byPeak = moodRatesByPeak(data.patterns);

    for (const [i, p] of data.patterns.entries()) {
        const at = `pattern[${i}] ${p.id ?? ''}`;
        total++;
        if (typeof p.id !== 'string' || !p.id.startsWith(`${mood}.`) || !/^[a-z_]+\.[a-z0-9_]+$/.test(p.id)) err(`${at}: id must be "${mood}.<snake_case>"`);
        if (ids.has(p.id)) err(`${at}: duplicate id (also in ${ids.get(p.id)})`); else ids.set(p.id, file);
        const lname = String(p.name ?? '').toLowerCase();
        if (!lname) err(`${at}: missing name`);
        else if (names.has(lname)) err(`${at}: duplicate name "${p.name}" (also in ${names.get(lname)})`); else names.set(lname, file);
        if (typeof p.description !== 'string' || !p.description || p.description.length > 120) err(`${at}: description missing or over 120 chars`);
        if (!isInt(p.energy) || p.energy < 1 || p.energy > 5) err(`${at}: energy must be integer 1-5`);
        if (!Array.isArray(p.tags) || p.tags.length < 1 || p.tags.length > 6) err(`${at}: tags must have 1-6 entries`);
        else for (const t of p.tags) if (!TAGS.has(t)) err(`${at}: unknown tag "${t}"`);
        // Patterns tagged "long" (marathons) may run up to 30 minutes with up to 200 steps.
        const long = Array.isArray(p.tags) && p.tags.includes('long');
        const maxSteps = long ? 200 : 60;
        const maxTotal = long ? 1860000 : 180000;
        if (!Array.isArray(p.steps) || p.steps.length < 6 || p.steps.length > maxSteps) { err(`${at}: needs 6-${maxSteps} steps`); continue; }

        let sum = 0;
        let bad = false;
        for (const [j, s] of p.steps.entries()) {
            if (!isInt(s.ms) || s.ms < 300 || s.ms > 60000) { err(`${at} step ${j}: ms must be integer 300-60000`); bad = true; }
            if (!('vibrate' in s)) { err(`${at} step ${j}: vibrate is required`); bad = true; }
            for (const [k, v] of Object.entries(s)) {
                if (k === 'ms') continue;
                if (!(k in CHANNELS)) { err(`${at} step ${j}: unknown field "${k}"`); bad = true; continue; }
                if (!isInt(v) || v < 0 || v > CHANNELS[k]) { err(`${at} step ${j}: ${k} must be integer 0-${CHANNELS[k]}`); bad = true; }
            }
            sum += s.ms || 0;
        }
        if (sum < 8000 || sum > maxTotal) err(`${at}: total length ${sum}ms, need 8000-${maxTotal}`);
        if (bad) continue;

        const { avg, peak } = patternIntensity(p.steps);
        const expected = suggestEnergy(p.steps, byPeak);
        const basis = byPeak ? `peak ${peak}` : `average vibrate ${avg.toFixed(1)}`;
        if (Math.abs(expected - p.energy) > 1) warn(`${at}: energy ${p.energy} but ${basis} suggests ~${expected}`);

        if (p.steps.some((st) => 'vibrate2' in st && st.vibrate2 !== st.vibrate)) {
            const wait = longestUnansweredMotor(p.steps);
            if (wait > MOTOR_ECHO_MS) err(`${at}: one motor is left waiting ${(wait / 1000).toFixed(1)}s for the other; answer it within ${MOTOR_ECHO_MS / 1000}s`);
        }

        const sh = shape(p.steps);
        if (shapes.has(sh)) err(`${at}: same shape as ${shapes.get(sh)} (scaled copy?)`); else shapes.set(sh, p.id);
    }
}

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `FAILED: ${errors.length} error(s)` : `OK: ${files.length} file(s), ${total} pattern(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
