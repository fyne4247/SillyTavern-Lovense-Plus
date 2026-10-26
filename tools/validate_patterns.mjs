#!/usr/bin/env node
// Validate patterns/*.json against docs/PATTERN_FORMAT.md.
// Usage: node tools/validate_patterns.mjs [mood ...]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'patterns');

const CHANNELS = {
    vibrate: 20, vibrate2: 20, rotate: 20, pump: 3, thrust: 20,
    suction: 20, fingering: 20, oscillate: 20,
};
const TAGS = new Set(['slow', 'fast', 'light', 'heavy', 'build', 'drop', 'steady', 'random',
    'pulse', 'wave', 'burst', 'silence', 'long', 'short', 'motion', 'squeeze', 'dual']);

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
    if (data.patterns.length < 12 || data.patterns.length > 24) err(`has ${data.patterns.length} patterns, need 12-24`);

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
        if (!Array.isArray(p.steps) || p.steps.length < 6 || p.steps.length > 60) { err(`${at}: needs 6-60 steps`); continue; }

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
        if (sum < 8000 || sum > 180000) err(`${at}: total length ${sum}ms, need 8000-180000`);
        if (bad) continue;

        const avg = p.steps.reduce((a, s) => a + s.vibrate * s.ms, 0) / sum;
        const expected = Math.min(5, Math.max(1, Math.round(avg / 4) || 1));
        if (Math.abs(expected - p.energy) > 1) warn(`${at}: energy ${p.energy} but average vibrate ${avg.toFixed(1)} suggests ~${expected}`);

        const sh = shape(p.steps);
        if (shapes.has(sh)) err(`${at}: same shape as ${shapes.get(sh)} (scaled copy?)`); else shapes.set(sh, p.id);
    }
}

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(errors.length ? `FAILED: ${errors.length} error(s)` : `OK: ${files.length} file(s), ${total} pattern(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
