#!/usr/bin/env node
// One-off migration: fold Lovense-only channels into the ones Intiface exposes.
// fingering -> rotate, oscillate -> thrust, suction (0-20) -> pump (0-3).
// Where a step already sets the target channel, the stronger value wins.
// Usage: node tools/fold_channels.mjs [mood ...]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'patterns');
const FOLDS = {
    fingering: ['rotate', (v) => v],
    oscillate: ['thrust', (v) => v],
    suction: ['pump', (v) => Math.round((v / 20) * 3)],
};

const moods = process.argv.slice(2);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json')
    .filter((f) => !moods.length || moods.includes(f.replace(/\.json$/, '')));
for (const file of files) {
    const path = join(DIR, file);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    let changed = 0;
    for (const pattern of data.patterns) {
        pattern.steps = pattern.steps.map((step) => {
            if (!Object.keys(FOLDS).some((k) => k in step)) return step;
            changed++;
            const out = {};
            for (const [key, value] of Object.entries(step)) {
                const fold = FOLDS[key];
                if (!fold) {
                    out[key] = Math.max(out[key] ?? 0, value);
                    continue;
                }
                const [target, scale] = fold;
                out[target] = Math.max(out[target] ?? step[target] ?? 0, scale(value));
            }
            return out;
        });
    }
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`${file}: ${changed} step(s) folded`);
}
