#!/usr/bin/env node
// Write patterns/index.json listing every mood file, so the browser knows what to load.
// Usage: node tools/build_pattern_index.mjs [--check]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'patterns');
const moods = readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
const json = `${JSON.stringify({ moods }, null, 4)}\n`;
const target = join(DIR, 'index.json');

if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current !== json) {
        console.log('patterns/index.json is out of date; run node tools/build_pattern_index.mjs');
        process.exit(1);
    }
    console.log(`OK: index lists ${moods.length} mood(s)`);
} else {
    writeFileSync(target, json);
    console.log(`Wrote patterns/index.json with ${moods.length} mood(s)`);
}
