/**
 * Lovense Remote / Lovense Connect transport (Game Mode LAN API), reached
 * through the SillyTavern server plugin in server/lovense.mjs.
 */
import { CHANNELS } from '../channels.js';

// Fallback channel map by toy type when the app doesn't report functions.
const TOY_CHANNELS = {
    nora: ['vibrate', 'rotate'],
    diamo: ['vibrate', 'rotate'],
    ridge: ['vibrate', 'rotate'],
    max: ['vibrate', 'pump'],
    'max 2': ['vibrate', 'pump'],
    edge: ['vibrate', 'vibrate2'],
    'edge 2': ['vibrate', 'vibrate2'],
    gemini: ['vibrate', 'vibrate2'],
    dolce: ['vibrate', 'vibrate2'],
    gravity: ['vibrate', 'thrusting'],
    'sex machine': ['vibrate', 'thrusting'],
    'mini sex machine': ['vibrate', 'thrusting'],
    solace: ['vibrate', 'thrusting'],
    'solace pro': ['vibrate', 'thrusting'],
    flexer: ['vibrate', 'fingering'],
    tenera: ['vibrate', 'suction'],
    'tenera 2': ['vibrate', 'suction'],
    osci: ['vibrate', 'oscillate'],
    'osci 2': ['vibrate', 'oscillate'],
    'osci 3': ['vibrate', 'oscillate'],
};

// Lovense Function actions (lowercase) -> the channel that drives them, the
// action name to send, and its range. Lovense names a few more functions than
// Intiface does; those fold into the nearest pattern channel.
const FUNCTIONS = {
    vibrate: { channel: 'vibrate', action: 'Vibrate', max: 20 },
    vibrate1: { channel: 'vibrate', action: 'Vibrate', max: 20 },
    vibrate2: { channel: 'vibrate2', action: 'Vibrate2', max: 20 },
    rotate: { channel: 'rotate', action: 'Rotate', max: 20 },
    fingering: { channel: 'rotate', action: 'Fingering', max: 20 },
    pump: { channel: 'pump', action: 'Pump', max: 3 },
    suction: { channel: 'pump', action: 'Suction', max: 20 },
    thrusting: { channel: 'thrust', action: 'Thrusting', max: 20 },
    oscillate: { channel: 'thrust', action: 'Oscillate', max: 20 },
};

// Each command keeps running this long unless replaced; the player refreshes sooner.
const COMMAND_SECONDS = 30;

export function formatLovenseHost(ip) {
    if (!ip) return '127-0-0-1.lovense.club';
    let host = ip.trim();
    if (host.endsWith('.lovense.club')) return host;
    if (host === 'localhost') host = '127.0.0.1';
    return `${host.replace(/\./g, '-')}.lovense.club`;
}

/** Lovense HTTP API runs on 20xxx ports, HTTPS on 30xxx. */
export function getLovenseProtocol(port) {
    const portNum = parseInt(port);
    return portNum >= 20000 && portNum < 30000 ? 'http' : 'https';
}

/**
 * A toy's Lovense functions (lowercase action names) from a GetToys entry:
 * what the app reports, or the built-in table when it reports nothing.
 * @param {object} toy
 * @returns {string[]}
 */
export function toyFunctions(toy) {
    const reported = Array.isArray(toy.fullFunctionNames) ? toy.fullFunctionNames : null;
    if (reported?.length) {
        const functions = new Set(['vibrate']);
        for (const fn of reported) {
            const name = String(fn).toLowerCase();
            if (FUNCTIONS[name]) functions.add(name === 'vibrate1' ? 'vibrate' : name);
        }
        return [...functions];
    }
    const type = String(toy.name || toy.toyType || '').toLowerCase();
    return TOY_CHANNELS[type] || ['vibrate'];
}

/**
 * Work out a toy's pattern channels from a GetToys entry.
 * @param {object} toy
 * @returns {string[]}
 */
export function toyChannels(toy) {
    return [...new Set(toyFunctions(toy).map((fn) => FUNCTIONS[fn].channel))];
}

/**
 * Build the Function action string for one set of channel values.
 * Dual-motor toys get Vibrate1/Vibrate2 so the motors can differ. Each channel
 * is sent as the toy's own function, rescaled to that function's range.
 * @param {Record<string, number>} values
 * @param {string[]} [functions] The toy's functions; defaults to the standard set
 */
export function buildAction(values, functions = ['vibrate', 'vibrate2', 'rotate', 'pump', 'thrusting']) {
    const parts = [];
    if ('vibrate2' in values) {
        parts.push(`Vibrate1:${values.vibrate ?? 0}`, `Vibrate2:${values.vibrate2}`);
    } else if ('vibrate' in values) {
        parts.push(`Vibrate:${values.vibrate}`);
    }
    for (const fn of functions) {
        const { channel, action, max } = FUNCTIONS[fn] || {};
        if (!channel || channel === 'vibrate' || channel === 'vibrate2' || !(channel in values)) continue;
        parts.push(`${action}:${Math.round((values[channel] / CHANNELS[channel]) * max)}`);
    }
    return parts.join(',');
}

export class LovenseRemoteTransport {
    /**
     * @param {object} opts
     * @param {(body: object) => Promise<any>} opts.request Posts a command through the server plugin and returns parsed JSON
     * @param {() => {ip: string, port: string}} opts.getAddress
     */
    constructor({ request, getAddress }) {
        this.request = request;
        this.getAddress = getAddress;
        this.devices = [];
        this.connected = false;
        this.listeners = new Set();
    }

    get name() {
        return 'Lovense Remote';
    }

    url() {
        const { ip, port } = this.getAddress();
        return `${getLovenseProtocol(port)}://${formatLovenseHost(ip)}:${port}/command`;
    }

    async call(command) {
        return this.request({ url: this.url(), ...command });
    }

    /**
     * Ask the app for its toys. Resolves to a status object; never throws.
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    async connect() {
        let status;
        try {
            const data = await this.call({ command: 'GetToys' });
            if (data?.code === 200 && data.data?.toys) {
                const toys = typeof data.data.toys === 'string' ? JSON.parse(data.data.toys) : data.data.toys;
                this.setDevices(Object.entries(toys)
                    .filter(([, toy]) => toy.status === undefined || String(toy.status) === '1')
                    .map(([id, toy]) => ({
                        id,
                        name: toy.nickName ? `${toy.name} (${toy.nickName})` : (toy.name || 'Unknown'),
                        channels: toyChannels(toy),
                        functions: toyFunctions(toy),
                        battery: toy.battery ?? null,
                        raw: toy,
                    })));
                status = this.devices.length ? { ok: true } : { ok: false, message: 'The app is reachable, but no toy is connected.' };
            } else if (data?.code === 401) {
                status = { ok: false, message: 'Lovense app connected, but no toy found. Pair your toy in Lovense Remote.' };
            } else if (data?.code === 402) {
                status = { ok: false, message: 'Toy found but not connected. Check Bluetooth in Lovense Remote.' };
            } else {
                status = { ok: false, message: data?.error || `Unexpected response (code ${data?.code})` };
            }
        } catch (error) {
            status = { ok: false, message: error.message };
        }
        if (!status.ok && status.message) this.setDevices([]);
        this.connected = status.ok;
        return status;
    }

    async disconnect() {
        this.connected = false;
        this.setDevices([]);
    }

    setDevices(devices) {
        this.devices = devices;
        for (const cb of this.listeners) cb(devices);
    }

    onDevicesChanged(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    listDevices() {
        return this.devices;
    }

    async send(deviceId, values) {
        const device = this.devices.find((d) => d.id === deviceId);
        const action = buildAction(values, device?.functions);
        if (!action) return;
        return this.call({ command: 'Function', action, timeSec: COMMAND_SECONDS, toy: deviceId, apiVer: 1 });
    }

    /** Send a raw Lovense API command (Legacy Mode presets and patterns). */
    async sendRaw(command) {
        return this.call(command);
    }

    async stopAll() {
        if (!this.connected) return;
        return this.call({ command: 'Function', action: 'Stop', timeSec: 0, apiVer: 1 }).catch(() => {});
    }
}
