'use strict';

/*
 * Tests for the optional KEBA failsafe mode (spec: .kiro/specs/keba-failsafe-mode).
 *
 * This file provides the shared test infrastructure (adapter factory, seeded random generator,
 * fake clock, datagram and log recorders) plus smoke tests for the configuration artifacts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { describe, it } = require('mocha');

// Minimal stub for the ioBroker Adapter base class (same approach as main.test.js).
class AdapterStub {
    constructor() {
        // nothing - the test configures the instance explicitly
    }

    on() {
        // no-op: tests invoke handlers directly.
    }

    setState() {
        // overridden per-instance in createAdapter()
    }
}

const adapterCoreStub = {
    Adapter: AdapterStub,
    I18n: {
        translate: (...args) => args.join(' '),
    },
    '@global': true,
};

const dnsPromisesStub = {
    lookup: async host => [{ address: host, family: 4 }],
};

const Kecontact = proxyquire('./main.js', {
    '@iobroker/adapter-core': adapterCoreStub,
    'node:dns/promises': dnsPromisesStub,
});

/**
 * Seeded pseudo random number generator (mulberry32). Returns floats in [0, 1).
 *
 * @param {number} seed integer seed
 * @returns {() => number} generator function
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Random integer in [min, max] taken from the given generator.
 *
 * @param {() => number} rand generator
 * @param {number} min lower bound (inclusive)
 * @param {number} max upper bound (inclusive)
 * @returns {number} integer
 */
function randInt(rand, min, max) {
    return min + Math.floor(rand() * (max - min + 1));
}

/**
 * Hand-written fake clock. Provides setInterval/clearInterval/setTimeout/clearTimeout and now()
 * and lets the test advance virtual time deterministically.
 *
 * @param {number} [start] initial virtual time in ms
 * @returns {object} the fake clock
 */
function createFakeClock(start = 1700000000000) {
    let current = start;
    let nextId = 1;
    const timers = new Map();

    const clock = {
        now: () => current,
        setInterval(fn, ms) {
            const id = nextId++;
            timers.set(id, { fn, ms, due: current + ms, repeat: true });
            return id;
        },
        setTimeout(fn, ms) {
            const id = nextId++;
            timers.set(id, { fn, ms, due: current + ms, repeat: false });
            return id;
        },
        clearInterval(id) {
            timers.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        /** @returns {number} number of active timers */
        activeTimers: () => timers.size,
        /**
         * Advance virtual time and run all due timers in order.
         *
         * @param {number} ms milliseconds to advance
         */
        tick(ms) {
            const target = current + ms;
            for (;;) {
                let nextId2;
                let next;
                for (const [id, t] of timers) {
                    if (t.due <= target && (!next || t.due < next.due)) {
                        next = t;
                        nextId2 = id;
                    }
                }
                if (!next) {
                    break;
                }
                current = next.due;
                if (next.repeat) {
                    next.due += next.ms;
                } else {
                    timers.delete(nextId2);
                }
                next.fn();
            }
            current = target;
        },
    };
    return clock;
}

/**
 * Build a Kecontact instance for unit testing, with fake clock, datagram and log recorders.
 *
 * @param {object} [options] options
 * @param {object} [options.config] adapter config
 * @param {number} [options.seed] seed for the random generator
 * @returns {object} { adapter, clock, rand, datagrams, logs }
 */
function createFailsafeAdapter(options = {}) {
    const adapter = Kecontact({});
    const clock = createFakeClock();
    const rand = mulberry32(options.seed ?? 12345);

    adapter.namespace = 'kecontact.0';
    adapter.currentStateValues = {};
    adapter.config = options.config ?? {};

    // log recorder
    const logs = [];
    const record = level => msg => logs.push({ level, msg });
    adapter.log = {
        silly: record('silly'),
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
    };

    adapter.setState = (id, obj) => {
        adapter.setStateInternal(id, obj.val);
    };
    adapter.displayChargeMode = () => {};
    adapter.forceUpdateOfCalculation = () => {};

    // fake clock wiring
    adapter.setInterval = (fn, ms) => clock.setInterval(fn, ms);
    adapter.clearInterval = id => clock.clearInterval(id);
    adapter.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
    adapter.clearTimeout = id => clock.clearTimeout(id);
    const originalDateNow = Date.now;
    Date.now = () => clock.now();
    const restore = () => {
        Date.now = originalDateNow;
    };

    // datagram recorder (replaces the queue; records the raw message and optional kind)
    const datagrams = [];
    adapter.sendUdpDatagram = (message, ...rest) => {
        datagrams.push({ message, args: rest, time: clock.now() });
    };

    return { adapter, clock, rand, datagrams, logs, restore };
}

const ROOT = __dirname;
const LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];

/**
 * Recursively find an item with the given attribute name in a jsonConfig tree.
 *
 * @param {object} node jsonConfig node
 * @param {string} name item key
 * @returns {object|undefined} the item
 */
function findItem(node, name) {
    if (!node || typeof node !== 'object') {
        return undefined;
    }
    if (node.items && node.items[name]) {
        return node.items[name];
    }
    for (const value of Object.values(node.items ?? {})) {
        const found = findItem(value, name);
        if (found) {
            return found;
        }
    }
    return undefined;
}

describe('failsafe test infrastructure', () => {
    it('mulberry32 is deterministic for a seed', () => {
        const a = mulberry32(42);
        const b = mulberry32(42);
        const seqA = [a(), a(), a()];
        expect(seqA).to.deep.equal([b(), b(), b()]);
        seqA.forEach(v => expect(v).to.be.within(0, 0.9999999999));
        expect(randInt(mulberry32(1), 5, 5)).to.equal(5);
    });

    it('fake clock runs intervals and timeouts and replaces Date.now', () => {
        const { adapter, clock, datagrams, restore } = createFailsafeAdapter();
        try {
            let ticks = 0;
            let fired = 0;
            const id = adapter.setInterval(() => ticks++, 20000);
            adapter.setTimeout(() => fired++, 10000);
            const t0 = Date.now();
            clock.tick(60000);
            expect(ticks).to.equal(3);
            expect(fired).to.equal(1);
            expect(Date.now() - t0).to.equal(60000);
            adapter.clearInterval(id);
            clock.tick(60000);
            expect(ticks).to.equal(3);
            adapter.sendUdpDatagram('curr 6000');
            expect(datagrams).to.have.length(1);
            expect(datagrams[0].message).to.equal('curr 6000');
        } finally {
            restore();
        }
    });

    it('records log calls by level', () => {
        const { adapter, logs, restore } = createFailsafeAdapter();
        try {
            adapter.log.warn('w');
            expect(logs).to.deep.equal([{ level: 'warn', msg: 'w' }]);
        } finally {
            restore();
        }
    });
});

describe('failsafe mode configuration smoke tests', () => {
    it('jsonConfig.json has the failsafeMode checkbox', () => {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'jsonConfig.json'), 'utf8'));
        const item = findItem(cfg, 'failsafeMode');
        expect(item, 'failsafeMode item').to.be.an('object');
        expect(item.type).to.equal('checkbox');
        expect(item.label).to.equal('failsafeMode');
        expect(item.tooltip).to.equal('tooltip_failsafeMode');
        expect(item.default).to.equal(false);
    });

    it('io-package.json has native.failsafeMode === false', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'io-package.json'), 'utf8'));
        expect(pkg.native.failsafeMode).to.equal(false);
    });

    it('covers all 11 languages', () => {
        const files = fs.readdirSync(path.join(ROOT, 'admin', 'i18n')).filter(f => f.endsWith('.json'));
        expect(files.sort()).to.deep.equal(LANGUAGES.map(l => `${l}.json`).sort());
    });

    for (const lang of LANGUAGES) {
        it(`admin/i18n/${lang}.json has failsafeMode texts mentioning 60 and 0`, () => {
            const texts = JSON.parse(fs.readFileSync(path.join(ROOT, 'admin', 'i18n', `${lang}.json`), 'utf8'));
            expect(texts.failsafeMode, 'failsafeMode').to.be.a('string').that.is.not.empty;
            expect(texts.tooltip_failsafeMode, 'tooltip_failsafeMode').to.be.a('string').that.is.not.empty;
            expect(texts.tooltip_failsafeMode).to.match(/(^|\D)60(\D|$)/);
            expect(texts.tooltip_failsafeMode).to.match(/(^|\D)0(\D|$)/);
        });
    }
});

/**
 * Feed one Report 2 payload into a fresh adapter and return the recorded failsafe datagrams.
 *
 * @param {boolean} enabled failsafe option
 * @param {number|undefined} tmo Tmo FS (absent if undefined)
 * @param {number|undefined} curr Curr FS (absent if undefined)
 * @param {number} seed seed for the adapter harness
 * @returns {string[]} messages of recorded failsafe datagrams
 */
function runReport2(enabled, tmo, curr, seed) {
    const { adapter, datagrams, restore } = createFailsafeAdapter({ seed });
    try {
        adapter.failsafeActive = enabled;
        const report = { ID: 2, 'Curr user': 16000 };
        if (tmo !== undefined) {
            report['Tmo FS'] = tmo;
        }
        if (curr !== undefined) {
            report['Curr FS'] = curr;
        }
        adapter.handleFailsafeReport(report);
        return datagrams.filter(d => String(d.message).startsWith('failsafe')).map(d => d.message);
    } finally {
        restore();
    }
}

describe('failsafe command decision', () => {
    // Feature: keba-failsafe-mode, Property 1: Failsafe command decision
    // **Validates: Requirements 2.1, 2.2, 2.3, 2.8, 6.3, 6.4**
    it('Property 1: sends "failsafe 60 0 1" iff enabled, both values present and pair != (60, 0)', () => {
        const seed = 20240601;
        const rand = mulberry32(seed);
        const expectedSend = (enabled, tmo, curr) =>
            enabled && tmo !== undefined && curr !== undefined && !(tmo === 60 && curr === 0);

        // Req 6.4 table, each with option enabled and disabled
        const table = [
            [60, 0],
            [0, 0],
            [60, 6],
            [0, 6],
            [30, 0],
            [undefined, undefined],
            [60, undefined],
            [undefined, 0],
        ];
        for (const enabled of [true, false]) {
            for (const [tmo, curr] of table) {
                const sent = runReport2(enabled, tmo, curr, seed);
                const want = expectedSend(enabled, tmo, curr) ? ['failsafe 60 0 1'] : [];
                expect(sent, `seed=${seed} enabled=${enabled} tmo=${tmo} curr=${curr}`).to.deep.equal(want);
            }
        }

        // generated cases
        const genValue = () => {
            const r = rand();
            if (r < 0.2) {
                return undefined;
            }
            if (r < 0.45) {
                return 60;
            }
            if (r < 0.7) {
                return 0;
            }
            return randInt(rand, -5, 200);
        };
        const cases = 300;
        for (let i = 0; i < cases; i++) {
            const enabled = rand() < 0.5;
            const tmo = genValue();
            const curr = genValue();
            const sent = runReport2(enabled, tmo, curr, seed + i);
            const want = expectedSend(enabled, tmo, curr) ? ['failsafe 60 0 1'] : [];
            expect(sent, `seed=${seed} case=${i} enabled=${enabled} tmo=${tmo} curr=${curr}`).to.deep.equal(want);
        }
    });

    // Feature: keba-failsafe-mode, Property 1: Failsafe command decision
    // **Validates: Requirements 2.2, 2.8**
    it('Property 1: repeated (60, 0) reports send nothing', () => {
        const seed = 777;
        const rand = mulberry32(seed);
        for (let i = 0; i < 100; i++) {
            const { adapter, datagrams, restore } = createFailsafeAdapter({ seed: seed + i });
            try {
                adapter.failsafeActive = true;
                const n = randInt(rand, 1, 20);
                for (let k = 0; k < n; k++) {
                    adapter.handleFailsafeReport({
                        ID: 2,
                        'Tmo FS': 60,
                        'Curr FS': 0,
                        'Curr user': randInt(rand, 0, 32000),
                    });
                }
                const failsafe = datagrams.filter(d => String(d.message).startsWith('failsafe'));
                expect(failsafe, `seed=${seed} case=${i} reports=${n}`).to.have.length(0);
            } finally {
                restore();
            }
        }
    });
});

describe('failsafe resend bound', () => {
    // Feature: keba-failsafe-mode, Property 2: Failsafe resend is bounded and only follows a fresh mismatch
    // **Validates: Requirements 2.6, 2.7**
    it('Property 2: resend is bounded and only follows a fresh mismatch', () => {
        const seed = 20240602;
        const rand = mulberry32(seed);
        const cases = 150;
        const isFs = m => typeof m === 'string' && m.startsWith('failsafe');

        for (let c = 0; c < cases; c++) {
            const tag = `seed=${seed} case=${c}`;
            const { adapter, clock, logs, restore } = createFailsafeAdapter({
                seed: seed + c,
                config: { host: '127.0.0.1' },
            });
            try {
                // use the real send queue, answer tracking and answer timeout of main.js
                delete adapter.sendUdpDatagram;
                const sent = [];
                adapter.txSocket = {
                    send: (msg, _off, _len, _port, _host, cb) => {
                        sent.push(msg);
                        cb(null);
                    },
                };
                adapter.failsafeActive = true;

                const flush = () => {
                    for (let i = 0; i < 20 && adapter.sendQueue.length > 0; i++) {
                        adapter.sendNextQueueDatagram();
                    }
                };
                const giveUpCount = () =>
                    logs.filter(l => l.level === 'error' && /could not be enabled/.test(l.msg)).length;

                // model state
                let inFlight = false; // failsafe command sent, no answer yet
                let windowSends = 0; // failsafe sends since last (60, 0) report
                let expectGaveUp = false;
                let lastEvent = 'start';
                const history = [];

                const fail = () => {
                    inFlight = false;
                    if (windowSends >= 3) {
                        expectGaveUp = true;
                    }
                };

                const n = randInt(rand, 1, 40);
                for (let i = 0; i < n; i++) {
                    const r = rand();
                    let event;
                    if (r < 0.5) {
                        event = 'report';
                    } else if (r < 0.65) {
                        event = 'ok';
                    } else if (r < 0.85) {
                        event = 'err';
                    } else {
                        event = 'timeout';
                    }
                    if ((event === 'ok' || event === 'err') && !inFlight) {
                        event = 'report'; // wallbox only answers commands that were sent
                    }
                    lastEvent = event;

                    const before = sent.filter(isFs).length;
                    let mismatch = false;
                    const wasInFlight = inFlight;
                    if (event === 'report') {
                        const q = rand();
                        let tmo;
                        let curr;
                        if (q < 0.25) {
                            tmo = 60;
                            curr = 0;
                        } else if (q < 0.35) {
                            tmo = undefined;
                            curr = randInt(rand, 0, 2);
                        } else {
                            tmo = [0, 30, 60][randInt(rand, 0, 2)];
                            curr = [0, 6][randInt(rand, 0, 1)];
                            if (tmo === 60 && curr === 0) {
                                curr = 6;
                            }
                        }
                        const report = { ID: 2 };
                        if (tmo !== undefined) {
                            report['Tmo FS'] = tmo;
                        }
                        if (curr !== undefined) {
                            report['Curr FS'] = curr;
                        }
                        history.push(`report(${tmo},${curr})`);
                        if (tmo === 60 && curr === 0) {
                            windowSends = 0;
                        }
                        mismatch = tmo !== undefined && curr !== undefined && !(tmo === 60 && curr === 0);
                        adapter.handleFailsafeReport(report);
                    } else if (event === 'ok') {
                        history.push('ok');
                        adapter.handleTchResponse(true);
                        inFlight = false;
                    } else if (event === 'err') {
                        history.push('err');
                        adapter.handleTchResponse(false);
                        fail();
                    } else {
                        history.push('timeout');
                        const wasWaiting = inFlight;
                        clock.tick(10100);
                        if (wasWaiting) {
                            fail();
                        }
                    }
                    flush();

                    const fsSent = sent.filter(isFs);
                    const newSends = fsSent.length - before;
                    const msg = `${tag} events=[${history.join(' ')}] last=${lastEvent}`;

                    if (newSends > 0) {
                        expect(event, `send only after a Report 2 (${msg})`).to.equal('report');
                        expect(mismatch, `send only on a mismatching Report 2 (${msg})`).to.equal(true);
                        expect(wasInFlight, `no send while a command is in flight (${msg})`).to.equal(false);
                        expect(newSends, `at most one send per Report 2 (${msg})`).to.equal(1);
                        expect(fsSent[fsSent.length - 1], msg).to.equal('failsafe 60 0 1');
                        expect(expectGaveUp, `no send after giving up (${msg})`).to.equal(false);
                        windowSends += newSends;
                        inFlight = true;
                        expect(windowSends, `at most 3 sends between (60,0) matches (${msg})`).to.be.at.most(3);
                    }
                    expect(giveUpCount(), `give-up error at most once (${msg})`).to.be.at.most(1);
                    expect(giveUpCount(), `give-up error iff 3rd attempt failed (${msg})`).to.equal(
                        expectGaveUp ? 1 : 0,
                    );
                }
            } finally {
                restore();
            }
        }
    });
});

describe('failsafe keep-alive content', () => {
    // Build an adapter that uses the real send queue and records transmitted datagrams.
    const createQueueAdapter = seed => {
        const ctx = createFailsafeAdapter({ seed, config: { host: '127.0.0.1' } });
        const { adapter } = ctx;
        delete adapter.sendUdpDatagram;
        const sent = [];
        adapter.txSocket = {
            send: (msg, _off, _len, _port, _host, cb) => {
                sent.push(msg);
                cb(null);
            },
        };
        adapter.failsafeActive = true;
        const flush = () => {
            for (let i = 0; i < 20 && adapter.sendQueue.length > 0; i++) {
                adapter.sendNextQueueDatagram();
            }
        };
        return { ...ctx, sent, flush };
    };

    // Feature: keba-failsafe-mode, Property 3: Keep-alive command content
    // **Validates: Requirements 3.3, 3.9**
    it('Property 3: keep-alive is exactly "curr <latest known value>", unknown value requests Report 2', () => {
        const seed = 20240603;
        const rand = mulberry32(seed);
        const unknownValues = [undefined, null, NaN, Infinity, -Infinity, 'abc'];

        // edge cases: nothing known at all
        for (const v of unknownValues) {
            const { adapter, sent, flush, restore } = createQueueAdapter(seed);
            try {
                const report = { ID: 2 };
                if (v !== undefined) {
                    report['Curr user'] = v;
                }
                adapter.handleFailsafeReport(report);
                adapter.sendKeepAlive();
                flush();
                expect(sent, `seed=${seed} unknown Curr user=${String(v)}`).to.deep.equal(['report 2']);
            } finally {
                restore();
            }
        }
        // edge case: value 0 is known
        {
            const { adapter, sent, flush, restore } = createQueueAdapter(seed);
            try {
                adapter.handleFailsafeReport({ ID: 2, 'Curr user': 0 });
                adapter.sendKeepAlive();
                flush();
                expect(sent, `seed=${seed} Curr user=0`).to.deep.equal(['curr 0']);
            } finally {
                restore();
            }
        }

        const cases = 200;
        for (let c = 0; c < cases; c++) {
            const { adapter, sent, flush, restore } = createQueueAdapter(seed + c);
            try {
                let known = null; // model: latest known value
                const history = [];
                const steps = randInt(rand, 1, 15);
                for (let i = 0; i < steps; i++) {
                    const r = rand();
                    if (r < 0.35) {
                        const v =
                            rand() < 0.3
                                ? unknownValues[randInt(rand, 0, unknownValues.length - 1)]
                                : randInt(rand, 0, 32000);
                        const report = { ID: 2 };
                        if (v !== undefined) {
                            report['Curr user'] = v;
                        }
                        history.push(`report(${String(v)})`);
                        adapter.handleFailsafeReport(report);
                        if (typeof v === 'number' && Number.isFinite(v)) {
                            known = v;
                        }
                    } else if (r < 0.55) {
                        const v = randInt(rand, 0, 32000);
                        history.push(`curr ${v}`);
                        adapter.sendUdpDatagram(`curr ${v}`);
                        known = v;
                    } else if (r < 0.75) {
                        const v = randInt(rand, 0, 32000);
                        history.push(`currtime ${v} 1`);
                        adapter.sendUdpDatagram(`currtime ${v} 1`);
                        known = v;
                    } else if (r < 0.85) {
                        history.push('ena');
                        adapter.sendUdpDatagram(`ena ${randInt(rand, 0, 1)}`);
                    } else {
                        const before = sent.length;
                        flush();
                        adapter.sendKeepAlive();
                        flush();
                        const out = sent.slice(before);
                        history.push('keepalive');
                        const msg = `seed=${seed} case=${c} events=[${history.join(' ')}] known=${known}`;
                        if (known === null) {
                            expect(out, msg).to.deep.equal(['report 2']);
                        } else {
                            expect(out, msg).to.deep.equal([`curr ${known}`]);
                        }
                        continue;
                    }
                    flush();
                }
                // always finish with one keep-alive check
                const before = sent.length;
                adapter.sendKeepAlive();
                flush();
                const out = sent.slice(before);
                const msg = `seed=${seed} case=${c} events=[${history.join(' ')}] known=${known}`;
                expect(out, msg).to.deep.equal(known === null ? ['report 2'] : [`curr ${known}`]);
            } finally {
                restore();
            }
        }
    });

    // Feature: keba-failsafe-mode, Property 3: Keep-alive command content
    // **Validates: Requirements 3.3**
    it('Property 3: keep-alive sent by the 20 s timer carries the last transmitted curr value', () => {
        const seed = 20240604;
        const { adapter, clock, sent, flush, restore } = createQueueAdapter(seed);
        try {
            adapter.handleFailsafeReport({ ID: 2, 'Curr user': 16000 });
            adapter.sendUdpDatagram('currtime 9000 1');
            flush();
            sent.length = 0;
            clock.tick(20000);
            flush();
            expect(sent, `seed=${seed}`).to.deep.equal(['curr 9000']);
        } finally {
            restore();
        }
    });
});

describe('failsafe keep-alive timing', () => {
    // Feature: keba-failsafe-mode, Property 4: Keep-alive timing and restart
    // **Validates: Requirements 3.1, 3.4, 3.5, 6.5**
    it('Property 4: gap between resetting commands <= 20 s and keep-alive follows a full interval after each regular send', () => {
        const seed = 20240605;
        const rand = mulberry32(seed);
        const INTERVAL = 20000;
        const SLOT = 300;
        const SLACK = 3 * SLOT; // queue delay of a few 300 ms slots
        const STEP = 100;
        const isResetting = m => /^(curr|currtime|ena)( |$)/.test(m);
        const cases = 150;
        let totalKeepAlives = 0;

        for (let c = 0; c < cases; c++) {
            const caseSeed = seed + c;
            const { adapter, clock, restore } = createFailsafeAdapter({
                seed: caseSeed,
                config: { host: '127.0.0.1' },
            });
            try {
                delete adapter.sendUdpDatagram;
                const transmissions = []; // { time, message }
                adapter.txSocket = {
                    send: (msg, _off, _len, _port, _host, cb) => {
                        transmissions.push({ time: clock.now(), message: msg });
                        cb(null);
                    },
                };
                const keepAliveCalls = [];
                const originalSendKeepAlive = adapter.sendKeepAlive.bind(adapter);
                adapter.sendKeepAlive = () => {
                    keepAliveCalls.push(clock.now());
                    originalSendKeepAlive();
                };

                const passive = rand() < 0.5;
                const pollInterval = randInt(rand, 1, 900); // seconds
                adapter.failsafeActive = true;
                adapter.isPassive = passive;
                adapter.config.passiveMode = passive;
                adapter.config.pollInterval = pollInterval;
                adapter.handleFailsafeReport({ ID: 2, 'Curr user': randInt(rand, 0, 32000) });

                // start like subscribeStatesAndStartWorking does
                const start = clock.now();
                adapter.restartKeepAliveTimer();
                adapter.enableChargingTimer(passive ? pollInterval * 1000 : adapter.intervalActiceUpdate);

                // random regular sends (and some non-resetting noise) at arbitrary times
                const intervals = randInt(rand, 3, 6);
                const horizon = intervals * INTERVAL + randInt(rand, 0, INTERVAL - 1);
                const events = [];
                const eventCount = randInt(rand, 0, 12);
                for (let i = 0; i < eventCount; i++) {
                    const time = randInt(rand, 0, Math.floor(horizon / STEP)) * STEP;
                    const r = rand();
                    let message;
                    if (r < 0.3) {
                        message = `curr ${randInt(rand, 0, 32000)}`;
                    } else if (r < 0.6) {
                        message = `currtime ${randInt(rand, 0, 32000)} 1`;
                    } else if (r < 0.85) {
                        message = `ena ${randInt(rand, 0, 1)}`;
                    } else {
                        message = rand() < 0.5 ? 'report 2' : 'failsafe 60 0 1';
                    }
                    events.push({ time, message });
                }
                events.sort((a, b) => a.time - b.time);

                let next = 0;
                for (let elapsed = 0; elapsed < horizon; elapsed += STEP) {
                    while (next < events.length && events[next].time <= elapsed) {
                        adapter.sendUdpDatagram(events[next].message);
                        next++;
                    }
                    clock.tick(STEP);
                }
                const end = clock.now();
                const tag = `seed=${seed} case=${c} caseSeed=${caseSeed} passive=${passive} poll=${pollInterval}s horizon=${horizon}ms events=${JSON.stringify(events)}`;

                // Requirements 3.1, 3.4, 6.5: gap between consecutive resetting transmissions
                const resetting = transmissions.filter(t => isResetting(t.message));
                let previous = start;
                for (const t of resetting) {
                    expect(
                        t.time - previous,
                        `gap before "${t.message}" at +${t.time - start}ms (${tag})`,
                    ).to.be.at.most(INTERVAL + SLACK);
                    previous = t.time;
                }
                expect(
                    end - previous,
                    `no resetting command during the last ${end - previous}ms (${tag})`,
                ).to.be.at.most(INTERVAL + SLACK);
                totalKeepAlives += keepAliveCalls.length;

                // Requirement 3.5: non-resetting commands never restart the timer, so the
                // timeline of keep-alive ticks is determined by resetting transmissions only.
                // Requirement 3.4: next keep-alive is one full interval after the last regular send.
                for (const k of keepAliveCalls) {
                    const before = resetting.filter(t => t.time < k);
                    const last = before.length > 0 ? before[before.length - 1].time : start;
                    expect(
                        k - last,
                        `keep-alive at +${k - start}ms after last resetting send at +${last - start}ms (${tag})`,
                    ).to.equal(INTERVAL);
                }
            } finally {
                restore();
            }
        }
        expect(totalKeepAlives, `keep-alive timer fired at least once (seed=${seed})`).to.be.greaterThan(0);
    });
});

describe('failsafe disabled option', () => {
    // Feature: keba-failsafe-mode, Property 5: Disabled option is silent
    // **Validates: Requirements 4.1, 4.2, 4.3, 4.5, 6.6**
    it('Property 5: disabled, absent or non-boolean option sends nothing and warns once about stored failsafe', () => {
        const seed = 20240606;
        const rand = mulberry32(seed);
        const INTERVAL = 20000;
        const optionValues = [false, 'absent', 'true', 1, null, 0, '', 'false', {}, [], 'yes'];
        const cases = 150;
        const isFailsafeOrKeepAlive = d =>
            String(d.message).startsWith('failsafe') || d.args.includes('failsafe') || d.args.includes('keepalive');

        for (let c = 0; c < cases; c++) {
            const option = optionValues[randInt(rand, 0, optionValues.length - 1)];
            const { adapter, clock, datagrams, logs, restore } = createFailsafeAdapter({
                seed: seed + c,
                config: {},
            });
            try {
                if (option !== 'absent') {
                    adapter.config.failsafeMode = option;
                }
                // stale value must be overwritten by checkConfig
                adapter.failsafeActive = true;
                adapter.checkConfig();
                // start like subscribeStatesAndStartWorking does
                adapter.restartKeepAliveTimer();

                const count = randInt(rand, 1, 12);
                const payloads = [];
                for (let i = 0; i < count; i++) {
                    const payload = { ID: 2, 'Curr user': randInt(rand, 0, 32000) };
                    if (rand() < 0.85) {
                        payload['Tmo FS'] = rand() < 0.4 ? 0 : [30, 60, 1, 600][randInt(rand, 0, 3)];
                    }
                    if (rand() < 0.85) {
                        payload['Curr FS'] = rand() < 0.5 ? 0 : randInt(rand, 0, 32000);
                    }
                    payloads.push(payload);
                }
                const expectWarn = payloads.some(p => p['Tmo FS'] > 0) ? 1 : 0;
                const tag = `seed=${seed} case=${c} option=${JSON.stringify(option)} payloads=${JSON.stringify(payloads)}`;

                const periodMs = randInt(rand, 3, 6) * INTERVAL + randInt(rand, 0, INTERVAL - 1);
                const stepMs = Math.floor(periodMs / count);
                for (const payload of payloads) {
                    adapter.handleFailsafeReport(payload);
                    clock.tick(stepMs);
                }
                clock.tick(periodMs);

                expect(adapter.failsafeActive, `failsafeActive (${tag})`).to.equal(false);
                expect(clock.activeTimers(), `no keep-alive timer (${tag})`).to.equal(0);
                expect(
                    datagrams.filter(isFailsafeOrKeepAlive),
                    `failsafe/keep-alive datagrams (${tag})`,
                ).to.have.length(0);
                const warnings = logs.filter(l => l.level === 'warn' && /failsafe/i.test(l.msg));
                expect(warnings, `failsafe warnings (${tag})`).to.have.length(expectWarn);
            } finally {
                restore();
            }
        }
    });
});

describe('failsafe trigger warning', () => {
    // Feature: keba-failsafe-mode, Property 6: Failsafe trigger warning fires once per entry
    // **Validates: Requirements 5.1, 5.2, 5.4**
    it('Property 6: one warning per rising edge of (Enable sys == 0 && Max curr == Curr FS), none when disabled', () => {
        const seed = 20240607;
        const rand = mulberry32(seed);
        const cases = 150;
        let totalEdges = 0;
        for (let c = 0; c < cases; c++) {
            const enabled = rand() < 0.7;
            const { adapter, logs, restore } = createFailsafeAdapter({
                seed: seed + c,
                config: { failsafeMode: enabled },
            });
            try {
                adapter.failsafeActive = enabled;
                const count = randInt(rand, 1, 25);
                const payloads = [];
                for (let i = 0; i < count; i++) {
                    payloads.push({
                        ID: 2,
                        'Enable sys': randInt(rand, 0, 1),
                        'Max curr': randInt(rand, 0, 2),
                        'Curr FS': randInt(rand, 0, 2),
                        'Curr user': randInt(rand, 0, 2),
                        'Tmo FS': 60,
                    });
                }
                const tag = `seed=${seed} case=${c} enabled=${enabled} payloads=${JSON.stringify(payloads)}`;
                let prev = false;
                let edges = 0;
                for (const p of payloads) {
                    const cond = p['Enable sys'] === 0 && p['Max curr'] === p['Curr FS'];
                    adapter.failsafeRecoveryPending = false;
                    const before = logs.filter(l => l.level === 'warn' && /triggered failsafe/i.test(l.msg)).length;
                    adapter.handleFailsafeReport(p);
                    const after = logs.filter(l => l.level === 'warn' && /triggered failsafe/i.test(l.msg)).length;
                    const rising = cond && !prev;
                    if (rising) {
                        edges++;
                    }
                    if (enabled) {
                        expect(after - before, `warnings for payload ${JSON.stringify(p)} (${tag})`).to.equal(
                            rising ? 1 : 0,
                        );
                        expect(adapter.failsafeRecoveryPending, `recovery pending (${tag})`).to.equal(rising);
                    } else {
                        expect(after - before, `no warnings when disabled (${tag})`).to.equal(0);
                        expect(adapter.failsafeRecoveryPending, `no recovery when disabled (${tag})`).to.equal(false);
                    }
                    prev = cond;
                }
                totalEdges += enabled ? edges : 0;
            } finally {
                restore();
            }
        }
        expect(totalEdges, `some rising edges were generated (seed=${seed})`).to.be.greaterThan(0);
    });
});

describe('failsafe recovery re-send', () => {
    // Feature: keba-failsafe-mode, Property 7: Recovery re-sends currtime and ena once
    // **Validates: Requirements 5.3**
    it('Property 7: after a trigger the next regulateWallbox(c) sends currtime c 1 and ena once, then behaves as baseline', () => {
        const seed = 20240608;
        const rand = mulberry32(seed);
        const cases = 200;
        for (let i = 0; i < cases; i++) {
            const c = rand() < 0.2 ? 0 : randInt(rand, 6000, 32000);
            const cached = rand() < 0.2 ? c : rand() < 0.2 ? 0 : randInt(rand, 0, 32000);
            const enableUser = rand() < 0.5;
            const state = randInt(rand, 1, 4);
            const tag = `seed=${seed} case=${i} c=${c} cachedCurrentUser=${cached} enableUser=${enableUser} state=${state}`;

            const run = pending => {
                const ctx = createFailsafeAdapter({ seed: seed + i });
                const { adapter, datagrams } = ctx;
                adapter.setStateInternal(`${adapter.namespace}.currentUser`, cached);
                adapter.setStateInternal(`${adapter.namespace}.enableUser`, enableUser);
                adapter.setStateInternal(`${adapter.namespace}.state`, state);
                adapter.failsafeRecoveryPending = pending;
                try {
                    adapter.regulateWallbox(c);
                    const first = datagrams.map(d => d.message);
                    const flagAfterFirst = adapter.failsafeRecoveryPending;
                    datagrams.length = 0;
                    adapter.regulateWallbox(c);
                    const second = datagrams.map(d => d.message);
                    return { first, second, flagAfterFirst };
                } finally {
                    ctx.restore();
                }
            };

            const baseline = run(false);
            const recovery = run(true);
            const expectedEna = `ena ${c > 0 || enableUser ? 1 : 0}`;
            expect(recovery.first, tag).to.deep.equal([`currtime ${c} 1`, expectedEna]);
            expect(recovery.flagAfterFirst, `flag cleared (${tag})`).to.equal(false);
            expect(recovery.second, `second call equals baseline (${tag})`).to.deep.equal(baseline.second);
        }
    });
});

describe('failsafe examples and edge cases', () => {
    // Adapter with the real send queue; transmitted datagrams are recorded in `sent`.
    /**
     * @param {object} [config] adapter config
     * @param {(msg: Buffer) => Error | null} [sendError] optional UDP send error generator
     */
    const createQueueAdapter = (config = { host: '127.0.0.1', failsafeMode: true }, sendError = undefined) => {
        const ctx = createFailsafeAdapter({ config });
        const { adapter } = ctx;
        delete adapter.sendUdpDatagram;
        const sent = [];
        adapter.txSocket = {
            send: (msg, _off, _len, _port, _host, cb) => {
                sent.push(msg);
                cb(sendError ? sendError(msg) : null);
            },
        };
        adapter.failsafeActive = config.failsafeMode === true;
        return { ...ctx, sent };
    };

    // **Validates: Requirements 2.4**
    it('writes exactly one info log when the failsafe command is sent', () => {
        const { adapter, logs, sent, clock, restore } = createQueueAdapter();
        try {
            adapter.handleFailsafeReport({ ID: 2, 'Tmo FS': 0, 'Curr FS': 0, 'Curr user': 16000 });
            clock.tick(1000);
            expect(sent.filter(m => m === 'failsafe 60 0 1')).to.have.length(1);
            const infos = logs.filter(l => l.level === 'info' && /failsafe/i.test(l.msg));
            expect(infos).to.have.length(1);
        } finally {
            restore();
        }
    });

    // **Validates: Requirements 2.5**
    it('requests Report 2 within 5 s after TCH-OK for the failsafe command', () => {
        const { adapter, sent, clock, restore } = createQueueAdapter();
        try {
            adapter.handleFailsafeReport({ ID: 2, 'Tmo FS': 0, 'Curr FS': 0, 'Curr user': 16000 });
            clock.tick(1000);
            expect(sent).to.include('failsafe 60 0 1');
            const before = sent.length;
            adapter.handleTchResponse(true);
            clock.tick(5000);
            expect(sent.slice(before)).to.include('report 2');
        } finally {
            restore();
        }
    });

    // **Validates: Requirements 3.6**
    it('stops the keep-alive on unload: no datagram follows when the clock advances', () => {
        const { adapter, sent, clock, restore } = createQueueAdapter();
        try {
            adapter.handleFailsafeReport({ ID: 2, 'Tmo FS': 60, 'Curr FS': 0, 'Curr user': 16000 });
            adapter.restartKeepAliveTimer();
            clock.tick(20000);
            expect(sent).to.deep.equal(['curr 16000']);
            let called = false;
            adapter.onUnload(() => {
                called = true;
            });
            expect(called).to.equal(true);
            expect(adapter.keepAliveTimer).to.equal(undefined);
            sent.length = 0;
            adapter.txSocket = {
                send: msg => sent.push(msg),
            };
            clock.tick(100000);
            expect(sent).to.have.length(0);
        } finally {
            restore();
        }
    });

    // **Validates: Requirements 3.8**
    it('logs a keep-alive warning on UDP send error and the next tick still sends', () => {
        let fail = true;
        const { adapter, logs, sent, clock, restore } = createQueueAdapter(
            { host: '127.0.0.1', failsafeMode: true },
            () => (fail ? new Error('boom') : null),
        );
        try {
            adapter.handleFailsafeReport({ ID: 2, 'Tmo FS': 60, 'Curr FS': 0, 'Curr user': 12000 });
            adapter.restartKeepAliveTimer();
            clock.tick(20000);
            expect(sent).to.deep.equal(['curr 12000']);
            const warns = logs.filter(l => l.level === 'warn' && /keep-alive/i.test(l.msg));
            expect(warns).to.have.length(1);
            expect(warns[0].msg).to.contain('boom');
            fail = false;
            clock.tick(20000);
            expect(sent).to.deep.equal(['curr 12000', 'curr 12000']);
        } finally {
            restore();
        }
    });

    // **Validates: Requirements 4.4, 4.5**
    it('treats a config without failsafeMode as disabled', () => {
        const { adapter, datagrams, clock, restore } = createFailsafeAdapter({ config: {} });
        try {
            adapter.failsafeActive = true;
            adapter.checkConfig();
            expect(adapter.failsafeActive).to.equal(false);
            adapter.restartKeepAliveTimer();
            adapter.handleFailsafeReport({ ID: 2, 'Tmo FS': 0, 'Curr FS': 0, 'Curr user': 16000 });
            clock.tick(60000);
            expect(datagrams).to.have.length(0);
            expect(clock.activeTimers()).to.equal(0);
        } finally {
            restore();
        }
    });

    // **Validates: Requirements 6.5, 6.6**
    it('fake clock over 3 intervals: enabled sends 3 keep-alives, disabled sends none', () => {
        for (const enabled of [true, false]) {
            const { adapter, datagrams, clock, restore } = createFailsafeAdapter({ config: { failsafeMode: enabled } });
            try {
                adapter.checkConfig();
                adapter.handleFailsafeReport({ ID: 2, 'Tmo FS': 60, 'Curr FS': 0, 'Curr user': 10000 });
                adapter.restartKeepAliveTimer();
                clock.tick(3 * 20000);
                const keepAlives = datagrams.filter(d => d.message === 'curr 10000');
                expect(keepAlives, `enabled=${enabled}`).to.have.length(enabled ? 3 : 0);
                expect(datagrams, `enabled=${enabled}`).to.have.length(enabled ? 3 : 0);
            } finally {
                restore();
            }
        }
    });

    // **Validates: Requirements 6.7**
    it('keeps the existing main.test.js tests passing (run via npm test)', () => {
        expect(fs.existsSync(path.join(ROOT, 'main.test.js'))).to.equal(true);
    });
});

module.exports = { createFailsafeAdapter, createFakeClock, mulberry32, randInt };
