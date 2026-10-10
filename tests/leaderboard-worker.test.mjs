import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createWorker } from '../backend/worker.mjs';
import signing from '../score-signing.js';

const ORIGIN = 'https://pavelzak.github.io';
const uuid = number => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const submission = (number = 1, extra = {}) => ({ id: uuid(number), name: 'Player', score: 1000, level: 3, ...extra });
const saved = (number = 1, extra = {}) => ({ ...submission(number), date: '2026-10-10T12:00:00.000Z', ...extra });

const SCHEMA = readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8');

// Execute the production schema and statements in real SQLite. Async wrappers
// model D1 boundaries, allowing concurrent requests to read the same revision.
class MemoryD1 {
    constructor(scores) {
        this.sqlite = new DatabaseSync(':memory:');
        this.sqlite.exec(SCHEMA);
        if (scores !== undefined) {
            this.sqlite.prepare('INSERT INTO leaderboard_state (id, revision, data) VALUES (1, 1, ?)')
                .run(JSON.stringify({ version: 1, scores }));
        }
        this.gets = 0;
        this.writes = [];
        this.conflicts = 0;
    }

    prepare(sql) {
        const statement = this.sqlite.prepare(sql);
        const database = this;
        function bound(parameters = []) {
            return {
                bind(...values) { return bound(values); },
                async first() {
                    database.gets++;
                    if (database.failReads) throw new Error(database.failReads);
                    const row = statement.get(...parameters) ?? null;
                    if (database.readBarrier) await database.readBarrier();
                    return row;
                },
                async run() {
                    database.writes.push({ sql, parameters });
                    if (database.failWrites) throw new Error(database.failWrites);
                    if (database.writeResult !== undefined) return database.writeResult;
                    if (database.alwaysConflict) {
                        database.sqlite.prepare('UPDATE leaderboard_state SET revision = revision + 1 WHERE id = 1').run();
                    }
                    const result = statement.run(...parameters);
                    if (result.changes === 0) database.conflicts++;
                    if (database.failAfterWrite) throw new Error('Response lost after committed write');
                    return { success: true, meta: { changes: result.changes } };
                },
            };
        }
        return bound();
    }

    get value() { return this.sqlite.prepare('SELECT data FROM leaderboard_state WHERE id = 1').get()?.data ?? null; }
    get revision() { return this.sqlite.prepare('SELECT revision FROM leaderboard_state WHERE id = 1').get()?.revision ?? null; }
    scores() { return JSON.parse(this.value).scores; }

    synchronizeReads(count) {
        // HMAC completion order is unspecified. Hold both snapshots so the test
        // exercises the production CAS conflict even when crypto finishes serially.
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        this.readBarrier = async () => {
            if (--count === 0) {
                delete this.readBarrier;
                release();
            }
            await ready;
        };
    }

    corrupt(data, revision = 1) {
        // Simulate legacy/manual corruption, including values now rejected by the schema.
        this.sqlite.exec('PRAGMA ignore_check_constraints = ON');
        this.sqlite.prepare('INSERT INTO leaderboard_state (id, revision, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data')
            .run(revision, data);
        this.sqlite.exec('PRAGMA ignore_check_constraints = OFF');
    }
}

function app(database = new MemoryD1(), options = {}) {
    const pauses = [];
    const rateKeys = [];
    const worker = createWorker({ pause: async delay => { pauses.push(delay); } });
    const env = {
        LEADERBOARD_DB: database,
        ALLOWED_ORIGIN: ORIGIN,
        SCORE_RATE_LIMITER: { async limit({ key }) { rateKeys.push(key); return { success: !options.rateLimited }; } },
    };
    function rawRequest(method = 'GET', value, headers = {}, path = '/scores') {
        return worker.fetch(new Request(`https://scores.example${path}`, {
            method,
            headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
            ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
        }), env);
    }
    async function request(method = 'GET', value, headers = {}, path = '/scores') {
        // Normal fixture submissions are signed like the browser. Validation tests
        // use rawRequest so missing signatures and malformed payloads stay untouched.
        if (method === 'POST' && value && typeof value.id === 'string' && typeof value.name === 'string'
            && Number.isSafeInteger(value.score) && Number.isInteger(value.level)
            && !Object.hasOwn(value, 'signature')) {
            value = { ...value, signature: await signing.signSubmission(value) };
        }
        return rawRequest(method, value, headers, path);
    }
    return { database, worker, env, request, rawRequest, pauses, rateKeys };
}

test('an empty public board reads without creating a row or storing visitor data', async () => {
    const api = app();
    const response = await api.worker.fetch(new Request('https://scores.example/scores'), api.env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { scores: [] });
    assert.equal(api.database.writes.length, 0);
    assert.deepEqual(api.rateKeys, []);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('first submission uses conflict-safe creation, strips whitespace, and assigns a server date', async () => {
    const api = app();
    const before = Date.now();
    const response = await api.request('POST', submission(10, { name: '  Pilot  ', id: uuid(10).toUpperCase(), level: 6 }), {
        'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': 'spoofed',
    });
    assert.equal(response.status, 200);
    const { scores } = await response.json();
    assert.equal(scores.length, 1);
    const expected = submission(10, { name: 'Pilot', level: 6 });
    assert.deepEqual({ ...scores[0], date: undefined }, { ...expected, signature: await signing.signSubmission(expected), date: undefined });
    assert.ok(Date.parse(scores[0].date) >= before && Date.parse(scores[0].date) <= Date.now());
    assert.deepEqual(api.rateKeys, ['submit:192.0.2.1']);
    assert.doesNotMatch(api.database.value, /192\.0\.2|spoofed|Connecting|Forwarded/);
    assert.match(api.database.writes[0].sql, /ON CONFLICT\(id\) DO NOTHING/);
    assert.equal(api.database.revision, 1);
});

test('two simultaneous first submissions cannot overwrite each other', async () => {
    const api = app();
    api.database.synchronizeReads(2);
    const responses = await Promise.all([api.request('POST', submission(1)), api.request('POST', submission(2))]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(api.database.conflicts, 1);
    assert.deepEqual(new Set(api.database.scores().map(row => row.id)), new Set([uuid(1), uuid(2)]));
    for (const row of api.database.scores()) assert.ok(await signing.verifySubmission(row, row.signature));
    assert.equal(api.pauses.length, 1);
});

test('concurrent updates merge with the latest state after a revision conflict', async () => {
    const api = app(new MemoryD1([saved(1)]));
    api.database.synchronizeReads(2);
    const responses = await Promise.all([
        api.request('POST', submission(2, { score: 500 })),
        api.request('POST', submission(3, { score: 1500 })),
    ]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(api.database.conflicts, 1);
    assert.deepEqual(api.database.scores().map(row => row.id), [uuid(3), uuid(1), uuid(2)]);
    assert.equal(api.database.writes[0].parameters[1], 1);
    assert.equal(api.database.writes.at(-1).parameters[1], 2);
    assert.equal(api.database.revision, 3);
    assert.deepEqual(api.database.scores().find(row => row.id === uuid(1)), saved(1));
    for (const row of api.database.scores().filter(row => row.id !== uuid(1))) {
        assert.ok(await signing.verifySubmission(row, row.signature));
    }
});

test('retrying an accepted submission is idempotent, including after simultaneous requests', async () => {
    const api = app();
    api.database.synchronizeReads(2);
    const responses = await Promise.all([api.request('POST', submission()), api.request('POST', submission())]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const original = api.database.value;
    const writeCount = api.database.writes.length;
    const again = await api.request('POST', submission());
    assert.equal(again.status, 200);
    assert.equal(api.database.value, original);
    assert.equal(api.database.scores().length, 1);
    assert.equal(api.database.writes.length, writeCount);
});

test('an existing submission ID cannot be used to replace its score', async () => {
    const api = app(new MemoryD1([saved()]));
    const original = api.database.value;
    const response = await api.request('POST', submission(1, { score: 99999 }));
    assert.equal(response.status, 409);
    assert.equal(api.database.value, original);
    assert.equal(api.database.writes.length, 0);
});

test('reads expose top ten; writes retain one hundred, ranked by score then level', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => saved(i + 1, { score: i * 100, level: i % 6 + 1 }));
    const api = app(new MemoryD1(rows));
    const read = await api.request();
    assert.deepEqual((await read.json()).scores.map(row => row.score), [9900, 9800, 9700, 9600, 9500, 9400, 9300, 9200, 9100, 9000]);
    const response = await api.request('POST', submission(101, { score: 9900, level: 6 }));
    const scores = (await response.json()).scores;
    assert.equal(scores.length, 10);
    assert.equal(scores[0].id, uuid(101));
    assert.equal(api.database.scores().length, 100);
    assert.ok(!api.database.scores().some(row => row.id === uuid(1)));
});

test('older timestamps win tied scores, followed by deterministic ID ordering', async () => {
    const rows = [saved(3), saved(2), saved(1, { date: '2026-10-09T12:00:00.000Z' })];
    const response = await app(new MemoryD1(rows)).request();
    assert.deepEqual((await response.json()).scores.map(row => row.id), [uuid(1), uuid(2), uuid(3)]);
});

test('malformed submissions never read or replace the shared state', async () => {
    for (const invalid of [
        null, [], {}, 'invalid JSON', submission(1, { id: 'anything' }),
        submission(1, { name: '' }), submission(1, { name: '     ' }), submission(1, { name: '1234567890123' }),
        submission(1, { name: 'a\nb' }), submission(1, { score: -1 }), submission(1, { score: 100001 }),
        submission(1, { score: 1.5 }), submission(1, { score: '1000' }), submission(1, { score: Number.MAX_SAFE_INTEGER }),
        submission(1, { level: 0 }), submission(1, { level: 7 }), submission(1, { level: 1.5 }),
        submission(1, { date: '2020-01-01' }), submission(1, { scores: [] }),
    ]) {
        const api = app(new MemoryD1([saved()]));
        const response = await api.rawRequest('POST', invalid);
        assert.equal(response.status, 400, JSON.stringify(invalid));
        assert.equal(api.database.gets, 0);
        assert.equal(api.database.writes.length, 0);
    }
});

test('missing, malformed, and forged signatures are rejected before any D1 access', async () => {
    const invalid = [
        submission(),
        ...[null, false, 123, {}, [], '', 'v1:bad', `v2:${'0'.repeat(64)}`, `v1:${'0'.repeat(64)}`]
            .map(signature => ({ ...submission(), signature })),
    ];
    for (const payload of invalid) {
        const api = app(new MemoryD1([saved()]));
        const original = api.database.value;
        const response = await api.rawRequest('POST', payload);
        assert.equal(response.status, 403);
        assert.match((await response.json()).error, /Reload the game/);
        assert.equal(response.headers.get('Retry-After'), null);
        assert.equal(api.database.gets, 0);
        assert.equal(api.database.writes.length, 0);
        assert.equal(api.database.value, original);
    }
});

test('changing any signed score field is rejected before reading or writing D1', async () => {
    const entry = submission();
    const signature = await signing.signSubmission(entry);
    for (const change of [{ id: uuid(2) }, { name: 'Impostor' }, { score: 1001 }, { level: 4 }]) {
        const api = app(new MemoryD1([saved()]));
        const response = await api.rawRequest('POST', { ...entry, ...change, signature });
        assert.equal(response.status, 403, JSON.stringify(change));
        assert.equal(api.database.gets, 0);
        assert.equal(api.database.writes.length, 0);
    }
});

test('legacy unsigned scores remain readable, deduplicate signed retries, and survive new signed writes', async () => {
    const legacy = saved(1);
    const api = app(new MemoryD1([legacy]));
    assert.deepEqual(await (await api.request()).json(), { scores: [legacy] });
    const original = api.database.value;
    assert.equal((await api.request('POST', submission(1))).status, 200);
    assert.equal(api.database.value, original);
    assert.equal(api.database.writes.length, 0);
    assert.equal((await api.request('POST', submission(2, { name: 'Игрок', score: 2000 }))).status, 200);
    const rows = api.database.scores();
    assert.deepEqual(rows.find(row => row.id === legacy.id), legacy);
    const added = rows.find(row => row.id === uuid(2));
    assert.ok(await signing.verifySubmission(added, added.signature));
    assert.deepEqual((await (await api.request()).json()).scores, rows);
});

test('only JSON is accepted, with bounds on both declared and streamed body size', async () => {
    const api = app();
    assert.equal((await api.request('POST', submission(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await api.request('POST', submission(), { 'Content-Length': '8193' })).status, 413);
    assert.equal((await api.request('POST', ' '.repeat(8193), { 'Content-Length': '1' })).status, 413);
    assert.equal((await api.request('POST', ' '.repeat(8193))).status, 413);
    assert.equal((await api.request('POST')).status, 400);
    const request = new Request('https://scores.example/scores', {
        method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: new Uint8Array([0xff]),
    });
    assert.equal((await api.worker.fetch(request, api.env)).status, 400);
    assert.equal(api.database.gets, 0);
});

test('allowed origin has CORS on success, errors, and preflight; other origins cannot write', async () => {
    const api = app();
    for (const response of [await api.request(), await api.request('POST', {}), await api.request('OPTIONS')]) {
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
        assert.equal(response.headers.get('Vary'), 'Origin');
    }
    const preflight = await api.request('OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /POST/);
    for (const origin of ['https://evil.example', `${ORIGIN}.evil.example`, 'null', '']) {
        const response = await api.request('POST', submission(), { Origin: origin });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }
    const missingOrigin = new Request('https://scores.example/scores', {
        method: 'POST', body: JSON.stringify(submission()), headers: { 'Content-Type': 'application/json' },
    });
    assert.equal((await api.worker.fetch(missingOrigin, api.env)).status, 403);
    assert.equal((await api.request('OPTIONS', undefined, { Origin: 'null' })).status, 403);
    assert.equal(api.database.writes.length, 0);
});

test('public GET remains readable outside browsers; CORS is limited to the configured origin', async () => {
    const response = await app().request('GET', undefined, { Origin: 'https://elsewhere.example' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('corrupt stored JSON, schema, rows, or duplicate IDs never get overwritten', async () => {
    const corruptValues = [
        'invalid', '{}', 'null', JSON.stringify({ version: 2, scores: [] }),
        JSON.stringify({ version: 1, scores: [saved(1, { date: 'invalid' })] }),
        JSON.stringify({ version: 1, scores: [saved(1, { score: -1 })] }),
        JSON.stringify({ version: 1, scores: [saved(1, { date: '2026-10-10' })] }),
        JSON.stringify({ version: 1, scores: [saved(1, { secret: 'never returned' })] }),
        JSON.stringify({ version: 1, scores: [saved(1, { signature: 'invalid' })] }),
        JSON.stringify({ version: 1, scores: [saved(1, { signature: null })] }),
        JSON.stringify({ version: 1, scores: [saved(), saved()] }),
        JSON.stringify({ version: 1, scores: Array.from({ length: 101 }, (_, i) => saved(i + 1)) }),
        ' '.repeat(65537),
    ];
    for (const value of corruptValues) {
        const database = new MemoryD1();
        database.corrupt(value);
        const api = app(database);
        for (const response of [await api.request(), await api.request('POST', submission(2))]) {
            assert.equal(response.status, 503);
            assert.doesNotMatch(await response.text(), /never returned|secret/);
        }
        assert.equal(database.value, value);
        assert.equal(database.writes.length, 0);
    }
});

test('conflict retries are bounded and preserve existing data when saturated', async () => {
    const database = new MemoryD1([saved()]);
    database.alwaysConflict = true;
    const original = database.value;
    const api = app(database);
    const response = await api.request('POST', submission(2));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '2');
    assert.equal(database.writes.length, 5);
    assert.equal(api.pauses.length, 4);
    assert.equal(database.value, original);
    assert.ok(api.pauses.every((delay, index) => delay >= 25 * 2 ** index && delay < 25 * 2 ** index + 25));
});

test('rate limits reject before storage and return a retry hint without exposing IP data', async () => {
    const api = app(undefined, { rateLimited: true });
    const response = await api.request('POST', submission(), { 'CF-Connecting-IP': '192.0.2.5' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.doesNotMatch(await response.text(), /192\.0\.2\.5/);
    assert.equal(api.database.gets, 0);
    assert.equal(api.database.writes.length, 0);
});

test('missing bindings and storage failures produce safe JSON errors with CORS', async () => {
    const api = app();
    api.database.failWrites = 'Internal storage error with private details';
    let response = await api.request('POST', submission());
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private|Internal|Error:/);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    delete api.env.SCORE_RATE_LIMITER;
    response = await api.request('POST', submission());
    assert.equal(response.status, 503);
    delete api.env.LEADERBOARD_DB;
    response = await api.request();
    assert.equal(response.status, 503);
});

test('unsupported paths and methods return JSON without touching storage', async () => {
    const api = app();
    const missing = await api.request('GET', undefined, {}, '/admin');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Not found.' });
    const method = await api.request('DELETE');
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('Allow'), 'GET, POST, OPTIONS');
    assert.equal(api.database.gets, 0);
});

test('the schema is repeatable and bounds the singleton row, revision, and UTF-8 data size', () => {
    const database = new MemoryD1([saved()]);
    const original = database.value;
    database.sqlite.exec(SCHEMA);
    assert.equal(database.value, original);
    assert.throws(() => database.sqlite.prepare('INSERT INTO leaderboard_state (id, revision, data) VALUES (2, 1, ?)').run('{}'), /CHECK/);
    for (const revision of [0, -1, 1.5, 'invalid', 9007199254740992]) {
        assert.throws(() => database.sqlite.prepare('UPDATE leaderboard_state SET revision = ? WHERE id = 1').run(revision), /CHECK/);
    }
    assert.throws(() => database.sqlite.prepare('UPDATE leaderboard_state SET data = ? WHERE id = 1').run('é'.repeat(32769)), /CHECK/);
    assert.equal(database.value, original);
    assert.equal(database.revision, 1);
});

test('corrupt revisions are unavailable and maximum revision cannot overflow on write', async () => {
    for (const revision of [0, -1, 1.5, 'invalid', 9007199254740992]) {
        const database = new MemoryD1([saved()]);
        const original = database.value;
        database.corrupt(original, revision);
        const api = app(database);
        assert.equal((await api.request()).status, 503);
        assert.equal((await api.request('POST', submission(2))).status, 503);
        assert.equal(database.value, original);
        assert.equal(database.writes.length, 0);
    }
    const database = new MemoryD1([saved()]);
    database.corrupt(database.value, Number.MAX_SAFE_INTEGER);
    const api = app(database);
    assert.equal((await api.request()).status, 200);
    assert.equal((await api.request('POST', submission(2))).status, 503);
    assert.equal(database.writes.length, 0);
});

test('exhausted D1 read or write quotas fail safely without changing stored scores', async () => {
    for (const failure of ['failReads', 'failWrites']) {
        const database = new MemoryD1([saved()]);
        const original = database.value;
        const revision = database.revision;
        database[failure] = 'D1_ERROR: daily quota exceeded; private account details';
        const api = app(database);
        const response = await api.request('POST', submission(2));
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('Retry-After'), '5');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
        assert.doesNotMatch(await response.text(), /D1_ERROR|quota|private|account/);
        assert.equal(database.value, original);
        assert.equal(database.revision, revision);
        assert.equal(api.pauses.length, 0);
        if (failure === 'failReads') assert.equal((await api.request()).status, 503);
    }
});

test('only successful D1 results with exactly zero or one changed row are accepted', async () => {
    for (const result of [
        null, {}, { success: false }, { success: false, meta: { changes: 1 } },
        { success: true }, { success: true, meta: {} },
        ...[-1, 2, '1', true, null].map(changes => ({ success: true, meta: { changes } })),
    ]) {
        const database = new MemoryD1([saved()]);
        database.writeResult = result;
        const original = database.value;
        const api = app(database);
        const response = await api.request('POST', submission(2));
        assert.equal(response.status, 503, JSON.stringify(result));
        assert.equal(database.writes.length, 1);
        assert.equal(api.pauses.length, 0);
        assert.equal(database.value, original);
    }
});

test('a lost D1 response after a committed write can be retried without duplication', async () => {
    const database = new MemoryD1([saved()]);
    const api = app(database);
    database.failAfterWrite = true;
    assert.equal((await api.request('POST', submission(2))).status, 503);
    const committed = database.value;
    const revision = database.revision;
    database.failAfterWrite = false;
    assert.equal((await api.request('POST', submission(2))).status, 200);
    assert.equal(database.value, committed);
    assert.equal(database.revision, revision);
    assert.equal(database.scores().filter(score => score.id === uuid(2)).length, 1);
    assert.equal(database.writes.length, 1);
});

test('submitted names are SQL parameters and cannot modify database structure', async () => {
    const api = app();
    const name = "'; DROP --";
    assert.equal((await api.request('POST', submission(1, { name }))).status, 200);
    assert.equal(api.database.scores()[0].name, name);
    assert.doesNotMatch(api.database.writes[0].sql, /DROP/);
    assert.equal((await api.request('POST', submission(2))).status, 200);
    assert.equal(api.database.scores().length, 2);
});
