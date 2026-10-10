const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const LB_KEY = 'invaders_leaderboard';

function game({ initial = {}, denyRead = false, denyWrite = false } = {}) {
    const values = new Map(Object.entries(initial));
    const elements = new Map();
    let frames = 0;
    function element() {
        const classes = new Set();
        let content = '';
        let markup = '';
        return {
            value: '',
            get textContent() { return content; },
            set textContent(value) {
                content = String(value);
                markup = content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
            },
            get innerHTML() { return markup; },
            set innerHTML(value) { markup = value; },
            classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
            addEventListener() {}, setAttribute() {}, getContext() { return {}; },
        };
    }
    const document = {
        hidden: false,
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, element());
            return elements.get(id);
        },
        querySelectorAll() { return ['start-screen', 'level-screen', 'gameover-screen', 'victory-screen'].map(id => this.getElementById(id)); },
        createElement: element,
        addEventListener() {},
    };
    const context = vm.createContext({
        window: { addEventListener() {} },
        document,
        localStorage: {
            getItem(key) {
                if (denyRead) throw new Error('Storage denied');
                return values.get(key) ?? null;
            },
            setItem(key, value) {
                if (denyWrite) throw new Error('Storage quota exceeded');
                values.set(key, value);
            },
        },
        requestAnimationFrame() { frames++; },
    });
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    const scores = () => JSON.parse(run('JSON.stringify(getLeaderboard())'));
    return { run, values, elements, scores, frames: () => frames };
}

test('invalid leaderboard JSON and top-level types cannot prevent startup', () => {
    for (const saved of ['invalid JSON', '{}', '"text"', '42', 'true', 'null']) {
        const app = game({ initial: { [LB_KEY]: saved } });
        assert.equal(app.frames(), 1, saved);
        assert.deepEqual(app.scores(), [], saved);
        assert.match(app.elements.get('start-lb').innerHTML, /No scores yet/);
    }
});

test('malformed score rows are discarded and loaded names are bounded and escaped', () => {
    const rows = [
        null, false, [], {},
        { name: 'Bad', score: null, level: 1 },
        { name: 42, score: 500, level: 1 },
        { name: 'String', score: '500', level: 1 },
        { name: 'Negative', score: -1, level: 1 },
        { name: 'Overflow', score: Number.MAX_SAFE_INTEGER + 1, level: 1 },
        { name: 'Bad level', score: 500, level: 0 },
        { name: 'Bad level', score: 500, level: 99 },
        { name: 'Long player name', score: 100, level: 1 },
        { name: '<img src=x>', score: 200, level: 2 },
    ];
    const app = game({ initial: { [LB_KEY]: JSON.stringify(rows) } });
    assert.equal(app.frames(), 1);
    assert.deepEqual(app.scores().map(e => [e.name, e.score]), [['<img src=x>', 200], ['Long player ', 100]]);
    assert.match(app.elements.get('start-lb').innerHTML, /&lt;img src=x&gt;/);
    assert.doesNotMatch(app.elements.get('start-lb').innerHTML, /<img/);
});

test('unavailable storage permits death, score submission, another game, and victory', () => {
    const app = game({ denyRead: true, denyWrite: true });
    app.run('beginGame(); score = 123; lives = 1; playerInvuln = 0; playerHit();');
    assert.equal(app.run('gameState'), 'gameOver');
    assert(app.elements.get('gameover-screen').classList.contains('active'));
    app.elements.get('name-input').value = 'Pilot';
    app.run('submitGameOver();');
    assert.equal(app.run('gameState'), 'start');
    assert(app.elements.get('start-screen').classList.contains('active'));
    assert.deepEqual(app.scores().map(e => [e.name, e.score]), [['Pilot', 123]]);
    app.run('beginGame(); score = 456; level = LEVELS.length; showVictory();');
    assert(app.elements.get('victory-screen').classList.contains('active'));
    assert.equal(app.elements.get('victory-name').value, 'Pilot');
    app.run('submitVictory();');
    assert.equal(app.run('gameState'), 'start');
    assert.deepEqual(app.scores().map(e => e.score), [456, 123]);
    assert.equal(app.scores()[0].level, 6);
});

test('a storage write failure keeps existing scores and new records for this session', () => {
    const existing = JSON.stringify([{ name: 'Old', score: 80, level: 1 }]);
    const app = game({ initial: { [LB_KEY]: existing, invaders_last_name: 'Old' }, denyWrite: true });
    app.run('beginGame(); score = 120; lives = 1; playerInvuln = 0; playerHit();');
    assert.equal(app.elements.get('name-input').value, 'Old');
    app.elements.get('name-input').value = 'New';
    app.run('submitGameOver(); beginGame(); showVictory();');
    assert.equal(app.elements.get('victory-name').value, 'New');
    assert.deepEqual(app.scores().map(e => [e.name, e.score]), [['New', 120], ['Old', 80]]);
    assert.equal(app.values.get(LB_KEY), existing);
});

test('saved scores remain sorted, limited to ten, and available after reload', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ name: 'Pilot ' + i, score: i * 10, level: 1 }));
    const app = game({ initial: { [LB_KEY]: JSON.stringify(rows) } });
    assert.equal(app.scores().length, 10);
    app.run('beginGame(); score = 999; lives = 1; playerInvuln = 0; playerHit();');
    app.elements.get('name-input').value = '  A long player name  ';
    app.run('submitGameOver();');
    const reloaded = game({ initial: Object.fromEntries(app.values) });
    assert.equal(reloaded.scores().length, 10);
    assert.deepEqual(reloaded.scores().map(e => e.score), [999, 140, 130, 120, 110, 100, 90, 80, 70, 60]);
    assert.equal(reloaded.scores()[0].name, 'A long playe');
    assert.equal(reloaded.values.get('invaders_last_name'), 'A long playe');
});

test('repeated end-game submissions cannot duplicate the same score', () => {
    const app = game();
    app.run('beginGame(); score = 100; lives = 1; playerInvuln = 0; playerHit(); submitGameOver(); submitGameOver();');
    assert.equal(app.scores().length, 1);
    app.run('beginGame(); score = 200; showVictory(); submitVictory(); submitVictory();');
    assert.equal(app.scores().length, 2);
    assert.deepEqual(app.scores().map(e => [e.name, e.score]), [['Anonymous', 200], ['Anonymous', 100]]);
});
