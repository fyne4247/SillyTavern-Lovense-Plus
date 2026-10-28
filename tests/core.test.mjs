import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveStep } from '../src/channels.js';
import { Player } from '../src/player.js';
import { Scheduler } from '../src/scheduler.js';
import { PatternLibrary, pickFromMood, patternLength, requiredChannels, patternFitsChannels, reconcileLengthSecs } from '../src/patterns.js';
import { scoreMoods, estimateEnergy, pickPattern, cleanText } from '../src/picker/script.js';
import { ApiPicker, parseMoodReply, parseJsonReply } from '../src/picker/api.js';
import { buildAction, toyChannels, toyFunctions, LovenseRemoteTransport } from '../src/transports/lovense_remote.js';
import { parseDevice, buildCommands, strokeDuration, IntifaceTransport } from '../src/transports/intiface.js';
import { parseAICommands, commandsToPattern, actionToValues, buildLegacyPrompt } from '../src/legacy.js';

// Fake clock for timer-driven classes.
function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => now,
        setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimer: (id) => timers.delete(id),
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
            }
            now = end;
        },
        get count() { return timers.size; },
    };
}

function fakeTransport(devices) {
    const sent = [];
    let stops = 0;
    return {
        sent,
        get stops() { return stops; },
        devices,
        listDevices: () => devices,
        send: (id, values) => { sent.push({ id, values }); },
        stopAll: () => { stops++; },
    };
}

const MOODS = [
    {
        mood: 'tease', label: 'Tease', description: 'light teasing', keywords: ['tease', 'teasing', 'barely', 'feather'],
        patterns: [
            { id: 'tease.a', energy: 1, steps: [{ ms: 1000, vibrate: 2 }] },
            { id: 'tease.b', energy: 2, steps: [{ ms: 1000, vibrate: 5 }] },
            { id: 'tease.c', energy: 3, steps: [{ ms: 1000, vibrate: 9 }] },
        ],
    },
    {
        mood: 'intense', label: 'Intense', description: 'relentless', keywords: ['harder', 'relentless', 'pound'],
        patterns: [
            { id: 'intense.a', energy: 4, steps: [{ ms: 1000, vibrate: 16 }] },
            { id: 'intense.b', energy: 5, steps: [{ ms: 1000, vibrate: 20 }] },
        ],
    },
];

// --- channels -------------------------------------------------------------

test('resolveStep derives missing channels from vibrate and keeps explicit ones', () => {
    assert.deepEqual(resolveStep({ vibrate: 20 }, ['vibrate', 'pump']), { vibrate: 20, pump: 3 });
    assert.deepEqual(resolveStep({ vibrate: 10, pump: 0 }, ['vibrate', 'pump']), { vibrate: 10, pump: 0 });
    assert.deepEqual(resolveStep({ vibrate: 8 }, ['vibrate', 'vibrate2']), { vibrate: 8, vibrate2: 8 });
    assert.deepEqual(resolveStep({ vibrate: 8, rotate: 3 }, ['vibrate']), { vibrate: 8 });
    assert.deepEqual(resolveStep({ vibrate: 30 }, ['vibrate']), { vibrate: 20 });
});

// --- player ---------------------------------------------------------------

test('player walks steps, loops, and only resends changed values', () => {
    const clock = fakeTimers();
    const transport = fakeTransport([{ id: 'a', channels: ['vibrate'] }]);
    const player = new Player({ transport, ...clock });
    player.play({ id: 'p', steps: [{ ms: 1000, vibrate: 5 }, { ms: 1000, vibrate: 5 }, { ms: 1000, vibrate: 9 }] });
    assert.deepEqual(transport.sent.map((s) => s.values.vibrate), [5]);
    clock.advance(1000);
    assert.equal(transport.sent.length, 1, 'unchanged step is not resent');
    clock.advance(1000);
    clock.advance(1000); // loops back to step 0
    assert.deepEqual(transport.sent.map((s) => s.values.vibrate), [5, 9, 5]);
});

test('player plays once and stops when loop is off', async () => {
    const clock = fakeTimers();
    const transport = fakeTransport([{ id: 'a', channels: ['vibrate'] }]);
    const changes = [];
    const player = new Player({ transport, onChange: (s) => changes.push(s.pattern?.id ?? null), ...clock });
    player.play({ id: 'p', steps: [{ ms: 500, vibrate: 5 }, { ms: 500, vibrate: 7 }] }, { loop: false });
    clock.advance(1000);
    assert.equal(player.playing, false);
    assert.equal(transport.stops, 1);
    assert.deepEqual(changes, ['p', null]);
});

test('player picks up devices that connect mid-pattern', () => {
    const clock = fakeTimers();
    const devices = [{ id: 'a', channels: ['vibrate'] }];
    const transport = fakeTransport(devices);
    const player = new Player({ transport, ...clock });
    player.play({ id: 'p', steps: [{ ms: 1000, vibrate: 5 }, { ms: 1000, vibrate: 6 }] });
    devices.push({ id: 'b', channels: ['vibrate', 'pump'] });
    clock.advance(1000);
    assert.deepEqual(transport.sent.at(-1), { id: 'b', values: { vibrate: 6, pump: 1 } });
});

test('player slows the air pump down without slowing the vibration', () => {
    const clock = fakeTimers();
    const transport = fakeTransport([{ id: 'a', channels: ['vibrate', 'pump'] }]);
    const player = new Player({ transport, getPumpSlowdown: () => 2, ...clock });
    // Pump track: 3 then 0 (mirrored from vibrate 0). At 2x it takes two passes.
    player.play({ id: 'p', steps: [{ ms: 1000, vibrate: 10, pump: 3 }, { ms: 1000, vibrate: 0 }] });
    for (let i = 0; i < 3; i++) clock.advance(1000);
    assert.deepEqual(transport.sent.map((s) => s.values), [
        { vibrate: 10, pump: 3 },
        { vibrate: 0, pump: 3 }, // vibration moved on, pump still on its first step
        { vibrate: 10, pump: 0 },
        { vibrate: 0, pump: 0 },
    ]);
});

test('player bridges big jumps between patterns', () => {
    const clock = fakeTimers();
    const transport = fakeTransport([{ id: 'a', channels: ['vibrate'] }]);
    const player = new Player({ transport, ...clock });
    player.play({ id: 'low', steps: [{ ms: 5000, vibrate: 2 }] });
    player.play({ id: 'high', steps: [{ ms: 5000, vibrate: 20 }] });
    assert.deepEqual(transport.sent.map((s) => s.values.vibrate), [2, 11]);
    clock.advance(600);
    assert.equal(transport.sent.at(-1).values.vibrate, 20);
    clock.advance(5000);
    clock.advance(5000);
    assert.ok(!transport.sent.slice(2).some((s) => s.values.vibrate === 11), 'bridge only plays once');
});

// --- scheduler ------------------------------------------------------------

test('scheduler debounces and restarts on reschedule', () => {
    const clock = fakeTimers();
    const fired = [];
    const scheduler = new Scheduler({ getDelayMs: () => 4000, onFire: (id) => fired.push(id), ...clock });
    scheduler.schedule(3);
    clock.advance(3000);
    scheduler.schedule(3); // swipe
    clock.advance(3000);
    assert.deepEqual(fired, []);
    clock.advance(1000);
    assert.deepEqual(fired, [3]);
    scheduler.schedule(4);
    scheduler.cancel();
    clock.advance(10000);
    assert.deepEqual(fired, [3]);
});

// --- library --------------------------------------------------------------

test('pattern library loads index and mood files and respects enabled map', async () => {
    const files = { 'index.json': { moods: ['tease', 'intense'] }, 'tease.json': MOODS[0], 'intense.json': MOODS[1] };
    const fetchImpl = async (url) => ({ json: async () => structuredClone(files[String(url).split('/').pop()]) });
    const lib = await new PatternLibrary().load('http://x/patterns/', fetchImpl);
    assert.equal(lib.size, 5);
    assert.equal(lib.get('intense.b').mood, 'intense');
    assert.deepEqual(lib.enabledMoods({ intense: false }).map((m) => m.mood), ['tease']);
});

test('length limit trims patterns and drops moods with none left', async () => {
    const lib = new PatternLibrary();
    lib.add(structuredClone(MOODS[0]));
    lib.add({ ...structuredClone(MOODS[1]), patterns: [{ id: 'intense.long', energy: 5, steps: [{ ms: 90000, vibrate: 20 }] }] });
    assert.equal(patternLength(lib.get('intense.long')), 90000);
    assert.deepEqual(lib.enabledMoods({}, 0).map((m) => m.mood), ['tease', 'intense']);
    assert.deepEqual(lib.enabledMoods({}, 30000).map((m) => m.mood), ['tease']);
    assert.deepEqual(lib.enabledMoods({}, 0, null, 50000).map((m) => m.mood), ['intense']);
    assert.deepEqual(lib.enabledMoods({}, 30000, null, 2000), []);
    assert.equal(lib.moods.get('intense').patterns.length, 1, 'library itself is not modified');
    assert.deepEqual(reconcileLengthSecs(60, 30, 'min'), { min: 60, max: 60 });
    assert.deepEqual(reconcileLengthSecs(60, 30, 'max'), { min: 30, max: 30 });
    assert.deepEqual(reconcileLengthSecs(60, 0, 'min'), { min: 60, max: 0 });
});

test('specialized patterns are the ones a feature carries on its own', () => {
    const answer = {
        steps: [
            { ms: 600, vibrate: 0, vibrate2: 20 },
            { ms: 600, vibrate: 20, vibrate2: 0 },
            { ms: 600, vibrate: 0, vibrate2: 18 },
            { ms: 600, vibrate: 18, vibrate2: 0 },
            { ms: 600, vibrate: 0, vibrate2: 15 },
            { ms: 600, vibrate: 15, vibrate2: 0 },
            { ms: 8000, vibrate: 0, vibrate2: 0 },
        ],
    };
    assert.deepEqual(requiredChannels(answer), ['vibrate2']);
    assert.equal(patternFitsChannels(answer, ['vibrate']), false);
    assert.equal(patternFitsChannels(answer, ['vibrate', 'vibrate2']), true);
    assert.equal(patternFitsChannels(answer, null), true, 'no toy yet means do not hide anything');

    const mirror = {
        steps: [
            { ms: 1500, vibrate: 5, thrust: 5 },
            { ms: 1500, vibrate: 12, thrust: 12 },
            { ms: 1500, vibrate: 18, thrust: 18 },
            { ms: 1500, vibrate: 0, thrust: 0 },
        ],
    };
    assert.deepEqual(requiredChannels(mirror), [], 'thrust that copies the vibration is not its own pattern');

    const poke = { steps: [{ ms: 500, vibrate: 10, rotate: 16 }, { ms: 8000, vibrate: 6 }] };
    assert.deepEqual(requiredChannels(poke), []);

    const ownPump = { steps: [{ ms: 4000, vibrate: 4, pump: 3 }] };
    assert.deepEqual(requiredChannels(ownPump), ['pump']);

    const spikes = JSON.parse(readFileSync(new URL('../patterns/spikes.json', import.meta.url), 'utf8'));
    const zap = spikes.patterns.find((p) => p.id === 'spikes.vibrate2_zap');
    assert.deepEqual(requiredChannels(zap), ['vibrate2']);
    const edging = JSON.parse(readFileSync(new URL('../patterns/edging.json', import.meta.url), 'utf8'));
    assert.deepEqual(requiredChannels(edging.patterns.find((p) => p.id === 'edging.thrusting_edge')), []);
    const combo = requiredChannels(edging.patterns.find((p) => p.id === 'edging.thrust_pump_combo'));
    assert.ok(combo.includes('thrust') && combo.includes('pump'));
});

test('feature filter drops specialized patterns and does not edit the library', () => {
    const lib = new PatternLibrary();
    lib.add({
        mood: 'spikes',
        label: 'Spikes',
        description: 'spikes for the test fixture here',
        keywords: [],
        patterns: [
            { id: 'spikes.plain', energy: 3, steps: [{ ms: 8000, vibrate: 8 }] },
            {
                id: 'spikes.duo',
                energy: 5,
                steps: [
                    { ms: 4000, vibrate: 0, vibrate2: 18 },
                    { ms: 4000, vibrate: 18, vibrate2: 0 },
                ],
            },
        ],
    });
    assert.deepEqual(lib.enabledMoods({}, 0, ['vibrate'])[0].patterns.map((p) => p.id), ['spikes.plain']);
    assert.equal(lib.moods.get('spikes').patterns.length, 2);
    assert.equal(lib.enabledMoods({}, 0, ['vibrate', 'vibrate2'])[0].patterns.length, 2);
    assert.equal(lib.enabledMoods({}, 0, ['vibrate', 'vibrate2']).length, 1);
    const onlyDuo = new PatternLibrary();
    onlyDuo.add({
        mood: 'dance',
        label: 'Dance',
        description: 'dance for the test fixture here',
        keywords: [],
        patterns: [{
            id: 'dance.duo',
            energy: 4,
            steps: [{ ms: 4000, vibrate: 0, vibrate2: 16 }, { ms: 4000, vibrate: 16, vibrate2: 0 }],
        }],
    });
    assert.deepEqual(onlyDuo.enabledMoods({}, 0, ['vibrate']), []);
});

test('pickFromMood prefers matching energy and avoids recent', () => {
    const p = pickFromMood(MOODS[0], 1, [], () => 0);
    assert.equal(p.id, 'tease.a');
    const q = pickFromMood(MOODS[0], 1, ['tease.a'], () => 0);
    assert.equal(q.id, 'tease.b');
});

// --- script picker --------------------------------------------------------

test('script picker scores keywords and weights the end of the message', () => {
    const scores = scoreMoods('She pulls back to tease you. Then harder, relentless.', MOODS);
    assert.equal(scores[0].mood, 'intense');
    assert.equal(scoreMoods('teasingly', MOODS)[0].score, 0, 'whole words only');
    assert.equal(cleanText('<b>hi</b> *smiles*'), 'hi smiles');
});

test('energy estimate reacts to exclamations and calm prose', () => {
    assert.ok(estimateEnergy('YES! NOW! HARDER! DON\'T STOP!') >= 4);
    assert.ok(estimateEnergy('She hums softly... letting the quiet afternoon stretch on and on, slow and unhurried, while the rain keeps falling against the window...') <= 2);
});

test('pickPattern keeps the current pattern when nothing matches', () => {
    assert.equal(pickPattern('hello there', MOODS, { playing: true }), null);
    assert.equal(pickPattern('hello there', MOODS, { playing: false }), null);
    const fb = pickPattern('hello there', MOODS, { playing: false, fallbackMood: 'tease', random: () => 0 });
    assert.equal(fb.mood, 'tease');
    const hit = pickPattern('Harder! Relentless!', MOODS, { random: () => 0 });
    assert.equal(hit.mood, 'intense');
});

// --- API picker -----------------------------------------------------------

test('parseMoodReply handles JSON, fenced JSON and bare names', () => {
    assert.deepEqual(parseMoodReply('{"mood":"tease","energy":2}', MOODS), { mood: 'tease', energy: 2 });
    assert.deepEqual(parseMoodReply('```json\n{"mood": "Intense", "energy": 9}\n```', MOODS), { mood: 'intense', energy: 5 });
    assert.deepEqual(parseMoodReply('I think intense fits.', MOODS), { mood: 'intense', energy: 3 });
    assert.equal(parseMoodReply('no idea', MOODS), null);
    assert.equal(parseJsonReply('nope'), null);
});

test('ApiPicker sends only the message and mood menu, and can pick an exact pattern', async () => {
    const calls = [];
    const replies = ['{"mood":"tease","energy":3}', '{"pattern":"tease.c"}'];
    const picker = new ApiPicker({ complete: async (messages) => { calls.push(messages); return replies.shift(); } });
    const result = await picker.pick('*She leans in*', MOODS, { pickPattern: true });
    assert.equal(result.pattern.id, 'tease.c');
    assert.match(calls[0][0].content, /- tease: light teasing/);
    assert.match(calls[0][1].content, /She leans in/);
    assert.match(calls[1].at(-1).content, /tease\.a \(energy 1\)/);
});

test('ApiPicker returns null on garbage so the caller can fall back', async () => {
    const picker = new ApiPicker({ complete: async () => 'sorry, I cannot help' });
    assert.equal(await picker.pick('text', MOODS), null);
});

// --- Lovense Remote -------------------------------------------------------

test('Lovense Remote builds actions and detects channels', () => {
    assert.equal(buildAction({ vibrate: 5, pump: 2 }), 'Vibrate:5,Pump:2');
    assert.equal(buildAction({ vibrate: 5, vibrate2: 9 }), 'Vibrate1:5,Vibrate2:9');
    assert.equal(buildAction({ vibrate: 5, thrust: 7 }), 'Vibrate:5,Thrusting:7');
    assert.deepEqual(toyChannels({ name: 'max' }), ['vibrate', 'pump']);
    assert.deepEqual(toyChannels({ name: 'whatever', fullFunctionNames: ['Vibrate1', 'Vibrate2'] }), ['vibrate', 'vibrate2']);
    assert.deepEqual(toyChannels({ name: 'lush' }), ['vibrate']);
});

test('Lovense Remote folds extra functions into the real channels', () => {
    // Flexer fingering rides rotate, Tenera suction rides pump (rescaled 0-3 -> 0-20),
    // Osci oscillation rides thrust.
    assert.deepEqual(toyChannels({ name: 'flexer' }), ['vibrate', 'rotate']);
    assert.deepEqual(toyChannels({ name: 'tenera' }), ['vibrate', 'pump']);
    assert.deepEqual(toyChannels({ name: 'osci 2' }), ['vibrate', 'thrust']);
    assert.equal(buildAction({ vibrate: 4, rotate: 9 }, toyFunctions({ name: 'flexer' })), 'Vibrate:4,Fingering:9');
    assert.equal(buildAction({ vibrate: 4, pump: 3 }, toyFunctions({ name: 'tenera' })), 'Vibrate:4,Suction:20');
    assert.equal(buildAction({ vibrate: 4, thrust: 6 }, toyFunctions({ name: 'osci' })), 'Vibrate:4,Oscillate:6');
    assert.deepEqual(toyFunctions({ fullFunctionNames: ['Vibrate', 'Suction'] }), ['vibrate', 'suction']);
});

test('Lovense Remote connect parses GetToys and sends per-toy commands', async () => {
    const requests = [];
    const t = new LovenseRemoteTransport({
        getAddress: () => ({ ip: '192.168.1.44', port: '20010' }),
        request: async (body) => {
            requests.push(body);
            if (body.command === 'GetToys') return { code: 200, data: { toys: JSON.stringify({ abc: { name: 'max', status: '1', battery: 80 }, off: { name: 'lush', status: '0' } }) } };
            return { code: 200 };
        },
    });
    assert.deepEqual(await t.connect(), { ok: true });
    assert.deepEqual(t.listDevices().map((d) => [d.id, d.channels]), [['abc', ['vibrate', 'pump']]]);
    await t.send('abc', { vibrate: 4, pump: 1 });
    assert.equal(requests[1].url, 'http://192-168-1-44.lovense.club:20010/command');
    assert.equal(requests[1].action, 'Vibrate:4,Pump:1');
    assert.equal(requests[1].toy, 'abc');
});

// --- Intiface -------------------------------------------------------------

const MAX2 = {
    DeviceIndex: 3, DeviceName: 'Lovense Max', DeviceMessages: {
        ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 3, ActuatorType: 'Constrict' }],
        StopDeviceCmd: {},
    },
};

test('Intiface parses devices into channels and builds scalar commands', () => {
    const d = parseDevice(MAX2);
    assert.deepEqual(d.channels, ['vibrate', 'pump']);
    assert.deepEqual(buildCommands(d, { vibrate: 10, pump: 3 }), [
        ['ScalarCmd', { DeviceIndex: 3, Scalars: [{ Index: 0, Scalar: 0.5, ActuatorType: 'Vibrate' }, { Index: 1, Scalar: 1, ActuatorType: 'Constrict' }] }],
    ]);
    const gemini = parseDevice({ DeviceIndex: 1, DeviceName: 'Lovense Gemini', DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 20, ActuatorType: 'Vibrate' }] } });
    assert.deepEqual(gemini.channels, ['vibrate', 'vibrate2']);
    const nora = parseDevice({ DeviceIndex: 2, DeviceName: 'Nora', DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }], RotateCmd: [{ StepCount: 20 }] } });
    assert.deepEqual(buildCommands(nora, { vibrate: 0, rotate: 20 })[1], ['RotateCmd', { DeviceIndex: 2, Rotations: [{ Index: 0, Speed: 1, Clockwise: true }] }]);
    assert.ok(strokeDuration(1) > strokeDuration(20));
});

test('Intiface maps Lovense thrusters (Oscillate) to thrust, preferring speed over strokes', () => {
    const gravity = parseDevice({ DeviceIndex: 4, DeviceName: 'Lovense Gravity', DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 20, ActuatorType: 'Oscillate' }] } });
    assert.deepEqual(gravity.channels, ['vibrate', 'thrust']);
    assert.deepEqual(buildCommands(gravity, { vibrate: 0, thrust: 10 }), [
        ['ScalarCmd', { DeviceIndex: 4, Scalars: [{ Index: 0, Scalar: 0, ActuatorType: 'Vibrate' }, { Index: 1, Scalar: 0.5, ActuatorType: 'Oscillate' }] }],
    ]);
    const solacePro = parseDevice({ DeviceIndex: 5, DeviceName: 'Lovense Solace Pro', DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: 'Oscillate' }], LinearCmd: [{ StepCount: 100 }] } });
    assert.deepEqual(solacePro.outputs.map((o) => o.kind), ['scalar']);
    const flexer = parseDevice({ DeviceIndex: 6, DeviceName: 'Lovense Flexer', DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 20, ActuatorType: 'Rotate' }] } });
    assert.deepEqual(flexer.channels, ['vibrate', 'vibrate2', 'rotate']);
});

class FakeSocket {
    static last = null;
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        FakeSocket.last = this;
        setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send(raw) {
        const [msg] = JSON.parse(raw);
        const [type, body] = Object.entries(msg)[0];
        this.sent.push(type);
        const reply = (t, extra = {}) => setTimeout(() => this.onmessage?.({ data: JSON.stringify([{ [t]: { Id: body.Id, ...extra } }]) }), 0);
        if (type === 'RequestServerInfo') reply('ServerInfo', { MaxPingTime: 0 });
        else if (type === 'RequestDeviceList') reply('DeviceList', { Devices: [MAX2] });
        else if (type === 'SensorReadCmd') reply('Error', { ErrorMessage: 'no sensor' });
        else reply('Ok');
    }
    close() { this.readyState = 3; }
}

test('Intiface transport handshakes, lists devices, and handles add/remove', async () => {
    const t = new IntifaceTransport({ getUrl: () => 'ws://test', WebSocketImpl: FakeSocket });
    const status = await t.connect();
    assert.deepEqual(status, { ok: true });
    assert.deepEqual(FakeSocket.last.sent.slice(0, 2), ['RequestServerInfo', 'RequestDeviceList']);
    assert.equal(t.listDevices()[0].name, 'Lovense Max');
    await t.send('3', { vibrate: 20, pump: 0 });
    assert.ok(FakeSocket.last.sent.includes('ScalarCmd'));
    FakeSocket.last.onmessage({ data: JSON.stringify([{ DeviceRemoved: { Id: 0, DeviceIndex: 3 } }]) });
    assert.equal(t.listDevices().length, 0);
    await t.disconnect();
});

// --- legacy ---------------------------------------------------------------

test('legacy parser still understands v1 tags', () => {
    const cmds = parseAICommands('Hi <lovense:vibrate="12" time="4"/> and <lovense:combo vibrate="5" pump="2"/> <lovense:stop/>');
    assert.equal(cmds.length, 3);
    assert.equal(cmds[0].action, 'Vibrate:12');
    assert.equal(cmds[1].action, 'Vibrate:5,Pump:2');
    assert.equal(cmds[2].action, 'Stop');
});

test('legacy commands translate into a pattern for non-Lovense transports', () => {
    assert.deepEqual(actionToValues('All:20'), { vibrate: 20, vibrate2: 20, rotate: 20, pump: 3, thrust: 20 });
    // Lovense-only functions fold into the channels Intiface has.
    assert.deepEqual(actionToValues('Suction:20,Fingering:7,Oscillate:5'), { pump: 3, rotate: 7, thrust: 5 });
    const cmds = parseAICommands('<lovense:vibrate="12" time="4"/><lovense:pattern strength="5;10" interval="100" time="0"/><lovense:preset name="wave" time="5"/>');
    const pattern = commandsToPattern(cmds, (mood) => (mood === 'waves' ? { steps: [{ ms: 1000, vibrate: 3 }] } : null));
    assert.deepEqual(pattern.steps, [
        { vibrate: 12, ms: 4000 },
        { ms: 300, vibrate: 5 },
        { ms: 300, vibrate: 10 },
        { ms: 1000, vibrate: 3 },
    ]);
});

test('legacy prompt lists connected toys and their capabilities', () => {
    const prompt = buildLegacyPrompt([{ name: 'max', channels: ['vibrate', 'pump'] }], 'be nice');
    assert.match(prompt, /Connected devices: max/);
    assert.match(prompt, /Pump \(0-3\)/);
    assert.match(prompt, /be nice/);
    assert.equal(buildLegacyPrompt([], 'x'), '');
});
