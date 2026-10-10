const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const script = readFileSync(join(__dirname, '..', 'index.html'), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
const row = (name = 'Pilot', score = 120) => ({
    id: '11111111-1111-4111-8111-111111111111', name, score, level: 1,
    date: '2026-10-10T00:00:00.000Z',
});
const response = (scores, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get() { return null; } },
    async json() { return { scores }; },
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const SIGNATURE = 'v1:' + 'ab'.repeat(32);

function app({ url = 'https://scores.example.test', fetchImpl, saved = [],
    signer = { async signSubmission() { return SIGNATURE; } } } = {}) {
    const elements = new Map();
    const values = new Map([['invaders_leaderboard', JSON.stringify(saved)]]);
    const calls = [];
    const timers = new Map();
    let clock = 0, timerId = 0, uuid = 0;
    function element() {
        let content = '', markup = '';
        return {
            value: '', classList: { add() {}, remove() {} },
            get textContent() { return content; },
            set textContent(value) {
                content = String(value);
                markup = content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
            },
            get innerHTML() { return markup; }, set innerHTML(value) { markup = value; },
            addEventListener() {}, setAttribute() {}, getContext() { return {}; },
        };
    }
    const context = vm.createContext({
        SpaceInvadersSigning: signer,
        window: {
            SPACE_INVADERS_LEADERBOARD_URL: url, addEventListener() {},
            crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
        },
        document: {
            hidden: false,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            querySelectorAll() { return []; }, createElement: element, addEventListener() {},
        },
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        requestAnimationFrame() {}, AbortController,
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, at: clock + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        fetch(url, options) {
            calls.push({ url, ...options });
            return fetchImpl ? fetchImpl(url, options, calls) : Promise.resolve(response([]));
        },
    });
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    async function advance(milliseconds) {
        const end = clock + milliseconds;
        for (;;) {
            await flush();
            const next = [...timers].filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            clock = timer.at;
            timers.delete(id);
            timer.callback();
        }
        clock = end;
        await flush();
    }
    function submit(name = 'Pilot', score = 120) {
        elements.get('name-input').value = name;
        run(`score = ${score}; level = 1; gameState = 'gameOver'; submitGameOver();`);
    }
    return { run, calls, values, advance, submit, board: () => elements.get('start-lb').innerHTML };
}

test('empty config makes no requests and labels fully working local scores', async () => {
    const game = app({ url: '', saved: [row('Local', 10)] });
    game.submit('New', 20);
    await flush();
    assert.equal(game.calls.length, 0);
    assert.equal(game.run('gameState'), 'start');
    assert.match(game.board(), /ON THIS DEVICE/);
    assert.match(game.board(), /New/);
    assert.equal(JSON.parse(game.values.get('invaders_leaderboard'))[0].score, 20);
});

test('remote scores are validated, sorted, capped at ten, and escaped', async () => {
    const scores = Array.from({ length: 12 }, (_, i) => row('Pilot ' + i, i * 10));
    scores.push(row('<img src=x>', 999), row('Too high', 100001), row('', 9999),
        { ...row('Bad level'), level: 99 }, { ...row('String'), score: '1000' }, null);
    const game = app({ fetchImpl: async () => response(scores) });
    await flush();
    assert.equal(game.calls.length, 1);
    assert.equal(game.calls[0].url, 'https://scores.example.test/scores');
    assert.equal(game.calls[0].credentials, 'omit');
    assert.match(game.board(), /GLOBAL HIGH SCORES/);
    assert.match(game.board(), /&lt;img src=x&gt;/);
    assert.doesNotMatch(game.board(), /<img|Too high|Bad level|String/);
    assert.equal((game.board().match(/class="lb-row"/g) || []).length, 10);
});

test('network failure retries finitely and shows honest local fallback', async () => {
    const game = app({ saved: [row('Local', 80)], fetchImpl: async () => { throw new TypeError('Offline'); } });
    await game.advance(1000);
    assert.equal(game.calls.length, 3);
    assert.match(game.board(), /ON THIS DEVICE/);
    assert.match(game.board(), /Global scores unavailable/);
    assert.match(game.board(), /Local/);
    assert.doesNotMatch(game.board(), /GLOBAL HIGH SCORES/);
});

test('submission returns immediately and lost-response retries preserve one id and payload', async () => {
    const accepted = new Map();
    let posts = 0;
    const signedEntries = [];
    const game = app({ signer: { async signSubmission(entry) {
        signedEntries.push(JSON.parse(JSON.stringify(entry)));
        return SIGNATURE;
    } }, fetchImpl: async (_, options) => {
        if (options.method === 'GET') return response([]);
        const entry = JSON.parse(options.body);
        accepted.set(entry.id, entry);
        posts++;
        if (posts === 1) throw new TypeError('Response lost after saving');
        if (posts === 2) return response([], 503);
        return response([...accepted.values()].map(entry => ({ ...entry, date: row().date })));
    } });
    await flush();
    game.submit('Winner', 240);
    assert.equal(game.run('gameState'), 'start');
    assert.equal(JSON.parse(game.values.get('invaders_leaderboard'))[0].name, 'Winner');
    await game.advance(1000);
    const requests = game.calls.filter(call => call.method === 'POST');
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests.map(request => request.body)).size, 1);
    assert.equal(accepted.size, 1);
    assert.equal(signedEntries.length, 1);
    const submitted = JSON.parse(requests[0].body);
    assert.deepEqual(submitted, { ...signedEntries[0], signature: SIGNATURE });
    assert.deepEqual(signedEntries[0], {
        id: '00000000-0000-4000-8000-000000000001', name: 'Winner', score: 240, level: 1,
    });
    assert.match(game.board(), /GLOBAL HIGH SCORES/);
    assert.match(game.board(), /Winner/);
    game.run('submitGameOver();');
    await flush();
    assert.equal(game.calls.filter(call => call.method === 'POST').length, 3);
});

test('public leaderboard reads work when the signing script is unavailable', async () => {
    const game = app({ signer: null, fetchImpl: async () => response([row('Public score', 500)]) });
    await flush();
    assert.equal(game.calls.length, 1);
    assert.equal(game.calls[0].method, 'GET');
    assert.equal(game.calls[0].body, undefined);
    assert.match(game.board(), /GLOBAL HIGH SCORES/);
    assert.match(game.board(), /Public score/);
});

test('unavailable or failed signing preserves local scores without sending unsigned requests', async () => {
    const unavailableSigners = [
        null,
        {},
        { async signSubmission() { throw new Error('Web Crypto unavailable'); } },
        { async signSubmission() { return ''; } },
        { async signSubmission() { return undefined; } },
    ];
    for (const signer of unavailableSigners) {
        const game = app({ signer });
        await flush();
        game.submit('Local pilot', 600);
        assert.equal(game.run('gameState'), 'start');
        await game.advance(1000);
        assert.equal(game.calls.filter(call => call.method === 'POST').length, 0);
        assert.equal(JSON.parse(game.values.get('invaders_leaderboard'))[0].score, 600);
        assert.match(game.board(), /ON THIS DEVICE/);
        assert.match(game.board(), /Local pilot/);
        assert.match(game.board(), /Global scores unavailable/);
    }
});

test('signing runs in the background and a delayed submission cannot replace a newer refresh', async () => {
    let finishSigning;
    const game = app({
        signer: { signSubmission() { return new Promise(resolve => { finishSigning = resolve; }); } },
        fetchImpl: async (_, options) => response([row(options.method === 'GET' ? 'Latest board' : 'Old submission')]),
    });
    await flush();
    game.submit('Pending pilot', 700);
    assert.equal(game.run('gameState'), 'start');
    assert.equal(game.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(JSON.parse(game.values.get('invaders_leaderboard'))[0].score, 700);
    await game.run('refreshOnlineLeaderboard()');
    finishSigning(SIGNATURE);
    await flush();
    assert.equal(game.calls.filter(call => call.method === 'POST').length, 1);
    assert.match(game.board(), /Latest board/);
    assert.doesNotMatch(game.board(), /Old submission/);
});

test('hanging requests time out, abort, and stop after three attempts', async () => {
    const game = app({ fetchImpl: () => new Promise(() => {}) });
    game.submit('Offline', 70);
    assert.equal(game.run('gameState'), 'start');
    await game.advance(14000);
    const posts = game.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 3);
    assert(posts.every(call => call.signal.aborted));
    assert.equal(new Set(posts.map(call => call.body)).size, 1);
    assert.match(game.board(), /ON THIS DEVICE/);
    assert.match(game.board(), /Offline/);
    assert.match(game.board(), /Global scores unavailable/);
});

test('a response body interrupted after saving retries the identical submission', async () => {
    let posts = 0;
    const game = app({ fetchImpl: async (_, options) => {
        if (options.method === 'GET') return response([]);
        posts++;
        if (posts === 1) return {
            ...response([]), async json() { throw new TypeError('Connection lost while reading response'); },
        };
        return response([{ ...JSON.parse(options.body), date: row().date }]);
    } });
    await flush();
    game.submit('Saved once', 270);
    await game.advance(1000);
    const requests = game.calls.filter(call => call.method === 'POST');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.match(game.board(), /GLOBAL HIGH SCORES/);
    assert.match(game.board(), /Saved once/);
});

test('an invalid response schema is not retried', async () => {
    const game = app({ fetchImpl: async () => ({ ...response([]), async json() { return { scores: {} }; } }) });
    await game.advance(1000);
    assert.equal(game.calls.length, 1);
    assert.match(game.board(), /ON THIS DEVICE/);
    assert.match(game.board(), /Global scores unavailable/);
});

test('a permanent rejection is not retried and a 429 response is retried', async () => {
    for (const status of [400, 429]) {
        let posts = 0;
        const game = app({ fetchImpl: async (_, options) => {
            if (options.method === 'GET') return response([]);
            posts++;
            return response([row('Accepted')], posts === 1 ? status : 200);
        } });
        await flush();
        game.submit();
        await game.advance(1000);
        assert.equal(posts, status === 400 ? 1 : 2);
        assert.match(game.board(), status === 400 ? /ON THIS DEVICE/ : /GLOBAL HIGH SCORES/);
    }
});

test('a long Retry-After switches to local scores instead of retrying too soon', async () => {
    const game = app({ saved: [row('Local')], fetchImpl: async () => ({
        ...response([], 429), headers: { get() { return '60'; } },
    }) });
    await game.advance(10000);
    assert.equal(game.calls.length, 1);
    assert.match(game.board(), /ON THIS DEVICE/);
    assert.match(game.board(), /Global scores unavailable/);
});

test('an old GET cannot replace a newer POST result', async () => {
    let finishGet;
    const game = app({ fetchImpl: (_, options) => options.method === 'GET'
        ? new Promise(resolve => { finishGet = resolve; })
        : Promise.resolve(response([row('New score', 300)])) });
    game.submit('New score', 300);
    await flush();
    finishGet(response([row('Old score', 10)]));
    await flush();
    assert.match(game.board(), /New score/);
    assert.doesNotMatch(game.board(), /Old score/);
});

test('an old GET cannot replace a newer refresh', async () => {
    let finishGet;
    const game = app({ fetchImpl: (_, options, calls) => calls.length === 1
        ? new Promise(resolve => { finishGet = resolve; })
        : Promise.resolve(response([row('Fresh score', 400)])) });
    await game.run('refreshOnlineLeaderboard()');
    finishGet(response([row('Stale score', 5)]));
    await flush();
    assert.match(game.board(), /Fresh score/);
    assert.doesNotMatch(game.board(), /Stale score/);
});

test('a stale success cannot relabel a failed current submission as global', async () => {
    let finishGet;
    const game = app({ fetchImpl: (_, options) => options.method === 'GET'
        ? new Promise(resolve => { finishGet = resolve; })
        : Promise.resolve(response([], 400)) });
    game.submit('Local score', 250);
    await flush();
    finishGet(response([row('Stale global', 10)]));
    await flush();
    assert.match(game.board(), /ON THIS DEVICE/);
    assert.match(game.board(), /Local score/);
    assert.doesNotMatch(game.board(), /GLOBAL HIGH SCORES|Stale global/);
});
