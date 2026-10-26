/**
 * Free, instant pattern picker: keyword scoring per mood plus a rough read of
 * how intense the message is.
 */
import { pickFromMood } from '../patterns.js';

/** Remove markup that shouldn't count as words. */
export function cleanText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[*_~`#>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score each mood by keyword hits. Hits in the last third of the message count
 * 1.5x, since the end of a message is where the scene is heading.
 * @returns {Array<{mood: string, score: number}>} sorted best first
 */
export function scoreMoods(text, moods) {
    const lower = cleanText(text).toLowerCase();
    const tail = lower.length * (2 / 3);
    const results = [];
    for (const mood of moods) {
        let score = 0;
        for (const keyword of mood.keywords || []) {
            const re = new RegExp(`(?<![a-z])${escapeRegex(keyword.toLowerCase())}(?![a-z])`, 'g');
            for (const match of lower.matchAll(re)) {
                score += match.index >= tail ? 1.5 : 1;
            }
        }
        results.push({ mood: mood.mood, score });
    }
    return results.sort((a, b) => b.score - a.score);
}

const CALM_WORDS = /\b(soft|softly|gentle|gently|slow|slowly|quiet|quietly|tender|tenderly|lazy|lazily|faint|light|lightly|calm|unhurried|drowsy|sleepy|hush)\b/g;
const INTENSE_WORDS = /\b(hard|harder|fast|faster|rough|roughly|deep|deeper|desperate|frantic|pound|pounding|slam|slams|relentless|brutal|wild|feral|savage)\b/g;

/**
 * Estimate energy 1-5 from punctuation, pacing and a few calm/intense words.
 * Exclamations, shouting and short clipped sentences push it up; ellipses and
 * long flowing sentences pull it down.
 */
export function estimateEnergy(text) {
    const clean = cleanText(text);
    if (!clean) return 3;
    const lower = clean.toLowerCase();
    const words = clean.split(' ').filter(Boolean);
    // Ellipses trail off rather than end a sentence.
    const sentences = clean.replace(/\.\.\.|…/g, ',').split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const exclaims = (clean.match(/!/g) || []).length;
    const caps = words.filter((w) => w.length >= 3 && /^[A-Z][A-Z!?.,'-]*$/.test(w)).length;
    const ellipses = (clean.match(/\.\.\.|…/g) || []).length;
    const avgLen = words.length / Math.max(1, sentences.length);
    const calm = (lower.match(CALM_WORDS) || []).length;
    const hot = (lower.match(INTENSE_WORDS) || []).length;

    let energy = 3;
    energy += Math.min(1.5, exclaims * 0.25);
    energy += Math.min(1, caps * 0.3);
    energy -= Math.min(1, ellipses * 0.2);
    energy -= Math.min(1.5, calm * 0.4);
    energy += Math.min(1.5, hot * 0.4);
    if (avgLen < 7) energy += 0.5;
    if (avgLen > 20) energy -= 0.5;
    return Math.max(1, Math.min(5, Math.round(energy)));
}

/**
 * Choose a pattern for a message.
 * @param {string} text
 * @param {Array<{mood: string, keywords: string[], patterns: object[]}>} moods Enabled moods
 * @param {object} [opts]
 * @param {string[]} [opts.recent] Recently played pattern ids
 * @param {string} [opts.fallbackMood] Mood to use when nothing matches and nothing is playing
 * @param {boolean} [opts.playing] Whether something is already playing (then no match = keep it)
 * @param {() => number} [opts.random]
 * @returns {{pattern: object, mood: string, energy: number, score: number} | null}
 */
export function pickPattern(text, moods, { recent = [], fallbackMood = null, playing = false, random = Math.random } = {}) {
    if (!moods.length) return null;
    const scores = scoreMoods(text, moods);
    const energy = estimateEnergy(text);
    let top = scores[0];

    if (top.score === 0) {
        if (playing) return null;
        const fallback = moods.find((m) => m.mood === fallbackMood);
        if (!fallback) return null;
        top = { mood: fallback.mood, score: 0 };
    } else {
        // Break near-ties randomly so the same few moods don't always win.
        const close = scores.filter((s) => s.score >= top.score * 0.85);
        top = close[Math.floor(random() * close.length)];
    }

    const mood = moods.find((m) => m.mood === top.mood);
    const pattern = pickFromMood(mood, energy, recent, random);
    return { pattern, mood: mood.mood, energy, score: top.score };
}
