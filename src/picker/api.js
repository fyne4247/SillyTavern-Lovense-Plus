/**
 * Pattern picker that asks a separate (ideally cheap) model through a
 * SillyTavern Connection Profile. It only sees the finished message and a
 * short menu, never the roleplay prompt.
 */
import { pickFromMood } from '../patterns.js';
import { cleanText } from './script.js';

const MAX_MESSAGE_CHARS = 4000;

export const DEFAULT_PICKER_PROMPT = `You choose haptic patterns for an adult roleplay. Read the latest message and decide what physical sensation fits it best right now: the mood of the moment and how intense it should feel.

Reply with ONLY a JSON object, no other text:
{"mood": "<one mood id from the list>", "energy": <1-5>}

energy: 1 = barely there, 3 = medium, 5 = maximum.`;

export const DEFAULT_PATTERN_PROMPT = `Now pick the single pattern from this mood that fits the message best.

Reply with ONLY a JSON object, no other text:
{"pattern": "<pattern id from the list>"}`;

/** Menu of enabled moods, one per line. */
export function moodMenu(moods) {
    return moods.map((m) => `- ${m.mood}: ${m.description}`).join('\n');
}

/** Menu of one mood's patterns, one per line. */
export function patternMenu(mood) {
    return mood.patterns.map((p) => `- ${p.id} (energy ${p.energy}): ${p.description}`).join('\n');
}

/** Pull the first JSON object out of a model reply, tolerating code fences and chatter. */
export function parseJsonReply(reply) {
    const text = String(reply || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Turn a mood reply into a mood + energy, accepting a bare mood name if the
 * model ignored the JSON instruction.
 */
export function parseMoodReply(reply, moods) {
    const json = parseJsonReply(reply);
    const ids = moods.map((m) => m.mood);
    let mood = typeof json?.mood === 'string' ? json.mood.trim().toLowerCase() : null;
    if (!ids.includes(mood)) {
        const lower = String(reply || '').toLowerCase();
        mood = ids.find((id) => new RegExp(`(?<![a-z_])${id}(?![a-z_])`).test(lower)) || null;
    }
    if (!mood) return null;
    const energy = Math.max(1, Math.min(5, Math.round(Number(json?.energy) || 3)));
    return { mood, energy };
}

/**
 * @param {object} opts
 * @param {(messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>} opts.complete
 *        Sends a chat request through the chosen connection profile and returns the reply text
 */
export class ApiPicker {
    constructor({ complete }) {
        this.complete = complete;
    }

    /**
     * @param {string} text Message to react to
     * @param {object[]} moods Enabled moods
     * @param {object} opts
     * @param {string} [opts.prompt] Custom system prompt
     * @param {number} [opts.maxTokens]
     * @param {boolean} [opts.pickPattern] Second call so the model chooses the exact pattern
     * @param {string[]} [opts.recent]
     * @returns {Promise<{pattern: object, mood: string, energy: number} | null>} null when the reply was unusable
     */
    async pick(text, moods, { prompt, maxTokens = 300, pickPattern = false, recent = [] } = {}) {
        if (!moods.length) return null;
        const message = cleanText(text).slice(-MAX_MESSAGE_CHARS);
        const system = (prompt || DEFAULT_PICKER_PROMPT).trim();
        const conversation = [
            { role: 'system', content: `${system}\n\nMoods:\n${moodMenu(moods)}` },
            { role: 'user', content: `Message:\n"""\n${message}\n"""` },
        ];

        const reply = await this.complete(conversation, maxTokens);
        const choice = parseMoodReply(reply, moods);
        if (!choice) return null;
        const mood = moods.find((m) => m.mood === choice.mood);

        if (pickPattern) {
            const followUp = [
                ...conversation,
                { role: 'assistant', content: JSON.stringify(choice) },
                { role: 'user', content: `${DEFAULT_PATTERN_PROMPT}\n\nPatterns in ${mood.mood}:\n${patternMenu(mood)}` },
            ];
            try {
                const json = parseJsonReply(await this.complete(followUp, maxTokens));
                const pattern = mood.patterns.find((p) => p.id === json?.pattern);
                if (pattern) return { pattern, mood: mood.mood, energy: choice.energy };
            } catch (error) {
                console.warn('[Lovense] Pattern follow-up call failed, picking by energy', error);
            }
        }

        return { pattern: pickFromMood(mood, choice.energy, recent), mood: mood.mood, energy: choice.energy };
    }
}
