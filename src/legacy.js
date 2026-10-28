/**
 * Legacy Mode: the roleplay model writes <lovense:.../> tags into its reply and
 * they are executed as they stream in. Kept for people who prefer the original
 * behaviour; off by default.
 */
import { CHANNELS } from './channels.js';

export const DEFAULT_GUIDELINES = `1. Match intensity to context: gentle (1-10), moderate (11-15), intense (16-20)
2. Use commands that fit the scene naturally
3. Multiple commands per response allowed
4. Commands loop until your next response`;

// Lovense action names -> our channel names and the action's own range, for
// running legacy commands on Intiface. Fingering, suction and oscillate fold
// into the channels Intiface actually exposes.
const ACTION_CHANNELS = {
    vibrate: ['vibrate', 20],
    vibrate1: ['vibrate', 20],
    vibrate2: ['vibrate2', 20],
    rotate: ['rotate', 20],
    fingering: ['rotate', 20],
    pump: ['pump', 3],
    suction: ['pump', 20],
    thrusting: ['thrust', 20],
    oscillate: ['thrust', 20],
};

// Our channel names -> the capability names the legacy prompt uses, for
// transports that don't report Lovense functions themselves.
const PROMPT_CAPABILITIES = {
    vibrate: 'vibrate',
    vibrate2: 'vibrate',
    rotate: 'rotate',
    pump: 'pump',
    thrust: 'thrusting',
};

// Lovense function names -> legacy prompt capability names.
const FUNCTION_CAPABILITIES = {
    vibrate: 'vibrate',
    vibrate2: 'vibrate',
    rotate: 'rotate',
    pump: 'pump',
    thrusting: 'thrusting',
    fingering: 'fingering',
    suction: 'suction',
    oscillate: 'oscillate',
};

// Built-in Lovense presets -> library patterns used when the transport can't play presets.
export const PRESET_PATTERNS = {
    pulse: 'rhythm',
    wave: 'waves',
    fireworks: 'chaos',
    earthquake: 'intense',
};

function findToyIdByName(devices, deviceName) {
    const nameLower = deviceName.toLowerCase();
    for (const device of devices) {
        const name = String(device.raw?.name || device.name || '').toLowerCase();
        const nickName = String(device.raw?.nickName || '').toLowerCase();
        if (name === nameLower || nickName === nameLower || String(device.name).toLowerCase() === nameLower) {
            return device.id;
        }
    }
    return null;
}

/**
 * Parse AI response for Lovense commands
 */
export function parseAICommands(text, devices = []) {
    // Match <lovense:action param="value"/> or <lovense:action/>
    const commandRegex = /<lovense:(\w+)([^>]*?)\/>/gi;
    const commands = [];
    let match;

    while ((match = commandRegex.exec(text)) !== null) {
        const action = match[1]; // vibrate, rotate, pump, preset, stop, pattern
        const attributesStr = match[2];

        // Parse attributes
        const attrs = {};
        const attrRegex = /(\w+)="([^"]+)"/g;
        let attrMatch;

        while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
            attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
        }

        // Handle shorthand format: <lovense:vibrate="3"/> where the first value has no attribute name
        // Check if attributesStr starts with =" (shorthand format)
        const shorthandMatch = /^\s*="([^"]+)"/.exec(attributesStr);
        if (shorthandMatch) {
            attrs[action.toLowerCase()] = shorthandMatch[1];
        }

        if (action.toLowerCase() === 'stop') {
            commands.push({
                command: 'Function',
                action: 'Stop',
                timeSec: 0,
                apiVer: 1,
            });
            continue;
        }

        if (action.toLowerCase() === 'preset') {
            const presetName = (attrs.name || '').toLowerCase();
            if (!presetName) continue;

            const duration = attrs.time || attrs.duration || 5;

            const presetObj = {
                command: 'Preset',
                name: presetName,
                timeSec: parseFloat(duration),
                apiVer: 1,
            };

            // Add device targeting if specified
            if (attrs.device) {
                const deviceName = attrs.device.toLowerCase();
                const toyId = findToyIdByName(devices, deviceName);
                if (toyId) {
                    presetObj.toy = toyId;
                }
            }

            commands.push(presetObj);
            continue;
        }

        // Handle pattern commands
        if (action.toLowerCase() === 'pattern') {
            const strength = attrs.strength;
            if (!strength) continue;

            const duration = attrs.time || attrs.duration || 0;
            const interval = attrs.interval || 150;

            // Build rule string based on which functions are enabled
            const functions = [];
            if (attrs.vibrate === 'true' || attrs.vibrate === '1' || !attrs.vibrate) functions.push('v');
            if (attrs.rotate === 'true' || attrs.rotate === '1') functions.push('r');
            if (attrs.pump === 'true' || attrs.pump === '1') functions.push('p');
            if (attrs.thrusting === 'true' || attrs.thrusting === '1') functions.push('t');
            if (attrs.fingering === 'true' || attrs.fingering === '1') functions.push('f');
            if (attrs.suction === 'true' || attrs.suction === '1') functions.push('s');
            if (attrs.depth === 'true' || attrs.depth === '1') functions.push('d');
            if (attrs.oscillate === 'true' || attrs.oscillate === '1') functions.push('o');

            const rule = `V:1;F:${functions.join(',')};S:${interval}#`;

            commands.push({
                command: 'Pattern',
                rule: rule,
                strength: strength,
                timeSec: parseFloat(duration),
                apiVer: 2,
            });
            continue;
        }

        // Handle combo commands (vibrate + rotate + pump + thrusting + fingering + suction + depth + oscillate + stroke + all)
        if (action.toLowerCase() === 'combo') {
            const actions = [];

            if (attrs.vibrate) {
                const intensity = parseInt(attrs.vibrate);
                if (!isNaN(intensity)) {
                    actions.push(`Vibrate:${intensity}`);
                }
            }

            if (attrs.rotate) {
                const intensity = parseInt(attrs.rotate);
                if (!isNaN(intensity)) {
                    actions.push(`Rotate:${intensity}`);
                }
            }

            if (attrs.pump) {
                const intensity = parseInt(attrs.pump);
                if (!isNaN(intensity)) {
                    actions.push(`Pump:${intensity}`);
                }
            }

            if (attrs.thrusting) {
                const intensity = parseInt(attrs.thrusting);
                if (!isNaN(intensity)) {
                    actions.push(`Thrusting:${intensity}`);
                }
            }

            if (attrs.fingering) {
                const intensity = parseInt(attrs.fingering);
                if (!isNaN(intensity)) {
                    actions.push(`Fingering:${intensity}`);
                }
            }

            if (attrs.suction) {
                const intensity = parseInt(attrs.suction);
                if (!isNaN(intensity)) {
                    actions.push(`Suction:${intensity}`);
                }
            }

            if (attrs.depth) {
                const intensity = parseInt(attrs.depth);
                if (!isNaN(intensity)) {
                    actions.push(`Depth:${intensity}`);
                }
            }

            if (attrs.oscillate) {
                const intensity = parseInt(attrs.oscillate);
                if (!isNaN(intensity)) {
                    actions.push(`Oscillate:${intensity}`);
                }
            }

            if (attrs.stroke) {
                // Stroke can be a single value or a range like "0-50"
                actions.push(`Stroke:${attrs.stroke}`);
            }

            if (attrs.all) {
                const intensity = parseInt(attrs.all);
                if (!isNaN(intensity)) {
                    actions.push(`All:${intensity}`);
                }
            }

            if (actions.length === 0) continue;

            const duration = attrs.time || attrs.duration || 5;

            const commandObj = {
                command: 'Function',
                action: actions.join(','),
                timeSec: parseFloat(duration),
                apiVer: 1,
            };

            // Parse optional loop parameters
            if (attrs.loop) {
                commandObj.loopRunningSec = parseFloat(attrs.loop);
            }
            if (attrs.pause) {
                commandObj.loopPauseSec = parseFloat(attrs.pause);
            }

            // Add stopPrevious parameter if specified (default is 1)
            if (attrs.stopprevious !== undefined) {
                commandObj.stopPrevious = parseInt(attrs.stopprevious);
            }

            commands.push(commandObj);
            continue;
        }

        // Parse intensity for individual action commands
        // Support both old format (intensity="X") and new format (action="X")
        let intensity;
        let actionString;
        const actionLower = action.toLowerCase();

        if (actionLower === 'stroke') {
            // Stroke can be intensity or range (e.g., "0-50")
            actionString = attrs[actionLower] || attrs.intensity || attrs.range || '0-100';
        } else {
            // Try new format first (e.g., vibrate="15"), then fall back to old format (intensity="15")
            const intensityValue = attrs[actionLower] || attrs.intensity;
            if (!intensityValue) continue;

            intensity = parseInt(intensityValue);
            if (isNaN(intensity)) continue;
            actionString = intensity.toString();
        }

        // Parse duration - support both 'time' and 'duration'
        const duration = attrs.time || attrs.duration || 5;

        // Capitalize action name to match Lovense API requirements
        const capitalizedAction = action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();

        const commandObj = {
            command: 'Function',
            action: `${capitalizedAction}:${actionString}`,
            timeSec: parseFloat(duration),
            apiVer: 1,
        };

        // Add device targeting if specified
        if (attrs.device) {
            const deviceName = attrs.device.toLowerCase();
            const toyId = findToyIdByName(devices, deviceName);
            if (toyId) {
                commandObj.toy = toyId;
            }
        }

        // Parse optional loop parameters
        if (attrs.loop) {
            commandObj.loopRunningSec = parseFloat(attrs.loop);
        }
        if (attrs.pause) {
            commandObj.loopPauseSec = parseFloat(attrs.pause);
        }

        // Add stopPrevious parameter if specified (default is 1)
        if (attrs.stopprevious !== undefined) {
            commandObj.stopPrevious = parseInt(attrs.stopprevious);
        }

        commands.push(commandObj);
    }

    return commands;
}



/**
 * Build the system prompt that teaches the roleplay model the tag syntax.
 * @param {Array<{name: string, channels: string[]}>} devices
 * @param {string} guidelines
 */
export function buildLegacyPrompt(devices, guidelines) {
    if (!devices.length) return '';

    const capabilities = new Set(['vibrate']);
    const toyDetails = devices.map((device) => {
        // Lovense Remote runs the tags raw, so offer the toy's own functions.
        const caps = device.functions
            ? [...new Set(device.functions.map((fn) => FUNCTION_CAPABILITIES[fn]).filter(Boolean))]
            : [...new Set(device.channels.map((ch) => PROMPT_CAPABILITIES[ch]).filter(Boolean))];
        caps.forEach((cap) => capabilities.add(cap));
        return { name: device.raw?.name || device.name, capabilities: caps };
    });

    const capabilityDescriptions = {
        'vibrate': '• Vibrate (0-20): ALL devices',
        'rotate': '• Rotate (0-20): Nora, Diamo, Ridge',
        'pump': '• Pump (0-3): Max, Max 2',
        'thrusting': '• Thrusting (0-20): Solace, Solace Pro, Sex Machine, Mini Sex Machine, Gravity',
        'fingering': '• Fingering (0-20): Flexer',
        'suction': '• Suction (0-20): Tenera, Tenera 2',
        'oscillate': '• Oscillate (0-20): Osci series',
    };
    const commandDescriptions = {
        'vibrate': '<lovense:vibrate="X" time="Y"/> - Vibrate at X (0-20) for Y seconds',
        'rotate': '<lovense:rotate="X" time="Y"/> - Rotate at X (0-20) for Y seconds',
        'pump': '<lovense:pump="X" time="Y"/> - Pump at X (0-3) for Y seconds',
        'thrusting': '<lovense:thrusting="X" time="Y"/> - Thrust at X (0-20) for Y seconds',
        'fingering': '<lovense:fingering="X" time="Y"/> - Fingering at X (0-20) for Y seconds',
        'suction': '<lovense:suction="X" time="Y"/> - Suction at X (0-20) for Y seconds',
        'oscillate': '<lovense:oscillate="X" time="Y"/> - Oscillate at X (0-20) for Y seconds',
    };

    const capabilitiesText = [...capabilities].map((cap) => capabilityDescriptions[cap]).filter(Boolean).join('\n');
    const commandsText = [...capabilities].map((cap) => commandDescriptions[cap]).filter(Boolean).join('\n');

    const hasThrusting = capabilities.has('thrusting');
    const strokeCommand = hasThrusting ? '\n• Stroke "MIN-MAX" (each 0-100, gap >=20): stroke length & depth — narrow range = short/shallow strokes, wide range = long/deep strokes' : '';
    const strokeExample = hasThrusting ? '\n<lovense:combo thrusting="10" stroke="20-90"/> - Speed 10 with long, deep strokes\n<lovense:combo thrusting="10" stroke="0-35"/> - Speed 10 with short, shallow strokes' : '';
    const comboAttrs = [...capabilities].slice(0, 2).map((cap) => `${cap}="10"`).join(' ');

    let deviceSection = '';
    if (toyDetails.length > 1) {
        deviceSection = '\n\nDevice Targeting:\nControl specific devices by adding device="name" parameter:\n';
        for (const toy of toyDetails) {
            deviceSection += `• ${toy.name}: ${toy.capabilities.join(', ')}\n`;
        }
        deviceSection += `\nExample: <lovense:vibrate="10" time="5" device="${toyDetails[0].name}"/>\nOmit device parameter to control all devices simultaneously.`;
    }

    return `You can control the user's Lovense device during this conversation:
<lovense>
Connected devices: ${toyDetails.map((t) => t.name).join(', ')}

Capabilities:
${capabilitiesText}${strokeCommand}

Commands (use self-closing XML-style tags):
${commandsText}
<lovense:all="X" time="Y"/> - Activate all functions at X (0-20) for Y seconds
<lovense:preset name="NAME" time="Y"/> - Use preset (pulse, wave, fireworks, earthquake) for Y seconds
<lovense:pattern strength="X;X;X" interval="MS" time="Y"/> - Custom pattern (semicolon-separated 0-20 values)
<lovense:stop/> - Stop all activity

Multiple functions: Combine in ONE command with the combo tag
<lovense:combo ${comboAttrs} time="10"/>${strokeExample}

Parameters:
loop="X" pause="Y" - Loop: X seconds on, Y seconds off
stopprevious="0" - Stack with previous commands (default: stop previous)${deviceSection}

Guidelines:
${guidelines || DEFAULT_GUIDELINES}
</lovense>`;
}

function seconds(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse "Vibrate:10,Rotate:5" (or "All:10") into channel values in native ranges. */
export function actionToValues(action) {
    const values = {};
    for (const part of String(action).split(',')) {
        const [name, raw] = part.split(':');
        const level = Number(raw);
        if (!Number.isFinite(level)) continue;
        const key = name.trim().toLowerCase();
        if (key === 'all') {
            for (const [ch, max] of Object.entries(CHANNELS)) values[ch] = Math.round((Math.min(20, level) / 20) * max);
            continue;
        }
        const [ch, max] = ACTION_CHANNELS[key] || [];
        if (!ch) continue;
        const scaled = Math.min(CHANNELS[ch], Math.max(0, Math.round((Math.min(max, level) / max) * CHANNELS[ch])));
        values[ch] = Math.max(values[ch] ?? 0, scaled);
    }
    return values;
}

/**
 * Convert parsed legacy commands into a pattern the player can run on any
 * transport. Stroke/Depth have no equivalent and are dropped.
 * @param {object[]} commands Output of parseAICommands
 * @param {(mood: string) => object|null} [presetLookup] Returns a library pattern for a preset's mood
 */
export function commandsToPattern(commands, presetLookup = () => null) {
    const steps = [];
    for (const cmd of commands) {
        if (cmd.command === 'Function') {
            if (cmd.action === 'Stop') continue;
            const values = actionToValues(cmd.action);
            if (!Object.keys(values).length) continue;
            const step = { vibrate: 0, ...values };
            const total = seconds(cmd.timeSec, 30) * 1000;
            if (cmd.loopRunningSec && cmd.loopPauseSec) {
                steps.push({ ...step, ms: Math.max(300, seconds(cmd.loopRunningSec, 1) * 1000) });
                steps.push({ vibrate: 0, ...Object.fromEntries(Object.keys(values).map((k) => [k, 0])), ms: Math.max(300, seconds(cmd.loopPauseSec, 1) * 1000) });
            } else {
                steps.push({ ...step, ms: Math.max(300, total) });
            }
        } else if (cmd.command === 'Pattern') {
            const levels = String(cmd.strength).split(';').map(Number).filter(Number.isFinite);
            if (!levels.length) continue;
            const fns = /F:([^;]*)/.exec(cmd.rule || '')?.[1]?.split(',') || ['v'];
            const interval = Math.max(300, Number(/S:(\d+)/.exec(cmd.rule || '')?.[1]) || 300);
            const map = { v: 'vibrate', r: 'rotate', p: 'pump', t: 'thrust', f: 'rotate', s: 'pump', o: 'thrust' };
            const total = seconds(cmd.timeSec, 0) * 1000;
            const passes = total ? Math.max(1, Math.round(total / (interval * levels.length))) : 1;
            for (let i = 0; i < passes; i++) {
                for (const level of levels) {
                    const step = { ms: interval, vibrate: Math.min(20, level) };
                    for (const f of fns) {
                        const ch = map[f];
                        if (ch && ch !== 'vibrate') step[ch] = Math.round((Math.min(20, level) / 20) * CHANNELS[ch]);
                    }
                    steps.push(step);
                }
            }
        } else if (cmd.command === 'Preset') {
            const preset = presetLookup(PRESET_PATTERNS[cmd.name]);
            if (preset) steps.push(...preset.steps);
        }
    }
    return steps.length ? { id: 'legacy.message', name: 'Message commands', steps } : null;
}

/**
 * Runs legacy commands. On Lovense Remote the original raw commands are sent
 * (so presets, patterns and stroke ranges behave exactly as before); on other
 * transports they're translated into a pattern for the player.
 */
export class LegacyController {
    /**
     * @param {object} opts
     * @param {() => object} opts.getTransport
     * @param {import('./player.js').Player} opts.player
     * @param {(mood: string) => object|null} opts.presetLookup
     */
    constructor({ getTransport, player, presetLookup }) {
        this.getTransport = getTransport;
        this.player = player;
        this.presetLookup = presetLookup;
        this.streamingText = '';
        this.executed = new Set();
        this.commands = [];
        this.loopTimer = null;
        this.looping = false;
    }

    get raw() {
        return typeof this.getTransport()?.sendRaw === 'function';
    }

    reset() {
        this.streamingText = '';
        this.executed.clear();
        this.commands = [];
    }

    /** Execute new commands as they appear in a streaming reply. */
    async onStreamToken(token) {
        this.streamingText += token;
        const devices = this.getTransport().listDevices();
        for (const command of parseAICommands(this.streamingText, devices)) {
            const key = JSON.stringify(command);
            if (this.executed.has(key)) continue;
            this.executed.add(key);
            this.commands.push(command);
            if (this.raw) {
                await this.getTransport().sendRaw(command);
            } else {
                const pattern = commandsToPattern([command], this.presetLookup);
                if (pattern) this.player.play(pattern, { loop: false });
            }
        }
    }

    /** Streaming finished: loop everything the message contained. */
    onGenerationEnded() {
        this.streamingText = '';
        this.startLoop(this.commands);
    }

    /** Non-streaming fallback. */
    onMessage(text) {
        const commands = parseAICommands(text, this.getTransport().listDevices());
        if (!commands.length) return;
        this.reset();
        this.commands = commands;
        this.startLoop(commands);
    }

    startLoop(commands) {
        this.stopLoop();
        if (!commands.length) return;
        if (!this.raw) {
            const pattern = commandsToPattern(commands, this.presetLookup);
            if (pattern) this.player.play(pattern, { loop: true });
            return;
        }

        const loopable = commands.filter((cmd) => cmd.action !== 'Stop').map((cmd) => ({
            ...cmd,
            // Infinite commands (timeSec 0) play for 30 seconds within the loop.
            timeSec: cmd.timeSec === 0 ? 30 : cmd.timeSec,
        }));
        if (!loopable.length) return;

        let index = 0;
        this.looping = true;
        const playNext = async () => {
            if (!this.looping) return;
            const command = loopable[index];
            await this.getTransport().sendRaw(command).catch(() => {});
            if (!this.looping) return;
            index = (index + 1) % loopable.length;
            this.loopTimer = setTimeout(playNext, (command.timeSec || 5) * 1000);
        };
        playNext();
    }

    stopLoop() {
        this.looping = false;
        clearTimeout(this.loopTimer);
        this.loopTimer = null;
    }

    async stop() {
        this.stopLoop();
        this.reset();
        await this.player.stop();
    }
}
