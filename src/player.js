import { mirroredLevel, resolveStep, sameValues } from './channels.js';

// Re-send unchanged values this often so a toy's own timeout never lapses mid-step.
const REFRESH_MS = 20000;
// Short bridge step inserted when a new pattern starts far from the current level.
const BRIDGE_MS = 600;
const BRIDGE_GAP = 8;

/**
 * Plays one pattern at a time on every device the transport currently reports.
 * Devices are re-read on every step, so toys that connect or drop mid-pattern
 * are picked up automatically.
 */
export class Player {
    /**
     * @param {object} opts
     * @param {{ listDevices(): Array<{id: string, channels: Iterable<string>}>, send(id: string, values: Record<string, number>): Promise<any>|any, stopAll(): Promise<any>|any }} opts.transport
     * @param {(state: {pattern: object|null, loop: boolean}) => void} [opts.onChange]
     * @param {() => number} [opts.now]
     * @param {(fn: Function, ms: number) => any} [opts.setTimer]
     * @param {(handle: any) => void} [opts.clearTimer]
     * @param {() => number} [opts.getPumpSlowdown] The air pump plays the pattern this many times slower
     */
    constructor({ transport, onChange = () => {}, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (handle) => clearTimeout(handle), getPumpSlowdown = () => 1 }) {
        this.transport = transport;
        this.getPumpSlowdown = getPumpSlowdown;
        this.onChange = onChange;
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.pattern = null;
        this.loop = true;
        this.steps = [];
        this.index = 0;
        this.timer = null;
        this.lastSent = new Map(); // deviceId -> { values, at }
        this.lastVibrate = 0;
        this.elapsed = 0; // ms into the pattern, counting every pass
    }

    get playing() {
        return this.pattern !== null;
    }

    /**
     * Start a pattern, replacing whatever is playing.
     * @param {{id: string, steps: Array<Record<string, number>>}} pattern
     * @param {{loop?: boolean}} [opts]
     */
    play(pattern, { loop = true } = {}) {
        if (!pattern?.steps?.length) return;
        this.clearTimer(this.timer);
        this.timer = null;

        const steps = [...pattern.steps];
        const first = steps[0].vibrate ?? 0;
        if (this.playing && Math.abs(first - this.lastVibrate) > BRIDGE_GAP) {
            steps.unshift({ ms: BRIDGE_MS, vibrate: Math.round((first + this.lastVibrate) / 2), bridge: true });
        }

        this.pattern = pattern;
        this.loop = loop;
        this.steps = steps;
        this.index = 0;
        this.elapsed = 0;
        this.onChange({ pattern, loop });
        this.tick();
    }

    /** Stop playback and tell every toy to stop. */
    async stop() {
        const wasPlaying = this.playing;
        this.clearTimer(this.timer);
        this.timer = null;
        this.pattern = null;
        this.steps = [];
        this.lastSent.clear();
        this.lastVibrate = 0;
        if (wasPlaying) this.onChange({ pattern: null, loop: this.loop });
        await this.transport.stopAll();
    }

    setLoop(loop) {
        this.loop = loop;
    }

    tick() {
        if (!this.playing) return;
        if (this.index >= this.steps.length) {
            // Bridge steps only run on the first pass.
            this.steps = this.steps.filter((s) => !s.bridge);
            if (!this.loop || this.steps.length === 0) {
                this.stop();
                return;
            }
            this.index = 0;
        }

        const step = this.steps[this.index++];
        this.applyStep(this.withSlowPump(step));
        this.elapsed += step.ms;
        this.timer = this.setTimer(() => this.tick(), step.ms);
    }

    /**
     * An air pump can't follow a fast pattern, so it runs on its own slower
     * clock: with a slowdown of 4 it traces the pattern's pump shape (or the
     * vibration, where the pattern leaves pump out) over four passes.
     */
    withSlowPump(step) {
        const slowdown = Number(this.getPumpSlowdown()) || 1;
        if (slowdown <= 1 || step.bridge) return step;
        const track = this.pattern.steps;
        const total = track.reduce((sum, s) => sum + s.ms, 0);
        if (!total) return step;
        let t = (this.elapsed / slowdown) % total;
        let source = track[track.length - 1];
        for (const s of track) {
            if (t < s.ms) { source = s; break; }
            t -= s.ms;
        }
        const pump = typeof source.pump === 'number' ? source.pump : mirroredLevel('pump', source.vibrate);
        return { ...step, pump };
    }

    applyStep(step) {
        const now = this.now();
        const devices = this.transport.listDevices();
        const seen = new Set();
        for (const device of devices) {
            seen.add(device.id);
            const values = resolveStep(step, device.channels);
            const prev = this.lastSent.get(device.id);
            if (prev && sameValues(prev.values, values) && now - prev.at < REFRESH_MS) continue;
            this.lastSent.set(device.id, { values, at: now });
            Promise.resolve(this.transport.send(device.id, values)).catch((err) => {
                console.warn('[Lovense] send failed', device.id, err);
            });
        }
        for (const id of [...this.lastSent.keys()]) {
            if (!seen.has(id)) this.lastSent.delete(id);
        }
        this.lastVibrate = step.vibrate ?? 0;
    }
}
