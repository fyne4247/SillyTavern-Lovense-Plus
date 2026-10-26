/**
 * Output channels a pattern step can drive, with their native ranges.
 * Pattern files and transports both use these names and scales.
 */
export const CHANNELS = {
    vibrate: 20,
    vibrate2: 20,
    rotate: 20,
    pump: 3,
    thrust: 20,
    suction: 20,
    fingering: 20,
    oscillate: 20,
};

/**
 * Work out what one device should do for one pattern step.
 * Channels the step sets explicitly are used as-is. Channels the device has but
 * the step leaves out follow `vibrate`, scaled to the channel's own range.
 * `vibrate2` copies `vibrate` when omitted.
 * @param {Record<string, number>} step Pattern step
 * @param {Iterable<string>} deviceChannels Channel names the device supports
 * @returns {Record<string, number>} Channel values in each channel's native range
 */
export function resolveStep(step, deviceChannels) {
    const out = {};
    const vibe = clamp(step.vibrate ?? 0, 0, CHANNELS.vibrate);
    for (const ch of deviceChannels) {
        const max = CHANNELS[ch];
        if (max === undefined) continue;
        if (typeof step[ch] === 'number') {
            out[ch] = clamp(Math.round(step[ch]), 0, max);
        } else if (ch === 'vibrate2') {
            out[ch] = vibe;
        } else {
            out[ch] = Math.round((vibe / CHANNELS.vibrate) * max);
        }
    }
    return out;
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** True when two channel-value objects are identical. */
export function sameValues(a, b) {
    if (!a || !b) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
}
