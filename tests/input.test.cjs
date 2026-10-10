const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function controls() {
    function target() {
        const listeners = new Map();
        return {
            textContent: '', innerHTML: '', value: '',
            classList: { add() {}, remove() {} },
            setAttribute() {}, getContext() { return {}; }, matches() { return false; },
            addEventListener(type, listener) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(listener);
            },
            dispatch(type, values = {}) {
                const event = { target: this, preventDefault() {}, ...values };
                for (const listener of listeners.get(type) || []) listener(event);
            },
        };
    }
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, target());
        return elements.get(id);
    };
    const window = target();
    const document = Object.assign(target(), {
        hidden: false, getElementById: element,
        querySelectorAll() { return []; }, createElement: target,
    });
    const context = vm.createContext({
        window, document,
        localStorage: { getItem() { return null; }, setItem() {} },
        requestAnimationFrame() {},
    });
    vm.runInContext(script, context);
    const run = source => vm.runInContext(source, context);
    const held = key => !!run(`keys[${JSON.stringify(key)}]`);
    const touch = (identifier, clientX, id) => ({ identifier, clientX, target: element(id) });
    const sendTouch = (id, type, touches, changedTouches) => element(id).dispatch(type, {
        touches, targetTouches: touches.filter(t => t.target === element(id)), changedTouches,
    });
    const keyboard = (type, key, code = key) => window.dispatch(type, {
        key, code, target: document.activeElement || window,
    });
    return { window, document, element, held, touch, sendTouch, keyboard, run };
}

test('a Fire tap between animation frames still creates exactly one shot', () => {
    const c = controls();
    c.run('beginGame()');
    const fire = c.touch(1, 500, 'btn-fire');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.sendTouch('btn-fire', 'touchend', [], [fire]);
    assert.equal(c.held(' '), false);
    c.run('updatePlayer(1 / 60)');
    assert.equal(c.run('playerBullets.length'), 1);
    c.run('updatePlayer(0.5)');
    assert.equal(c.run('playerBullets.length'), 1);
});

test('a tap during the firing cooldown waits for one shot without bypassing the cooldown', () => {
    const c = controls();
    c.run('beginGame()');
    const fire = c.touch(1, 500, 'btn-fire');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.run('updatePlayer(0.01)');
    c.sendTouch('btn-fire', 'touchend', [], [fire]);
    c.run('updatePlayer(0.1)');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.sendTouch('btn-fire', 'touchend', [], [fire]);
    c.run('updatePlayer(0.1)');
    assert.equal(c.run('playerBullets.length'), 1);
    c.run('updatePlayer(0.16)');
    assert.equal(c.run('playerBullets.length'), 2);
    c.run('updatePlayer(0.5)');
    assert.equal(c.run('playerBullets.length'), 2);
});

test('holding Fire repeats at the normal interval and stops on release', () => {
    const c = controls();
    c.run('beginGame()');
    const fire = c.touch(1, 500, 'btn-fire');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.run('updatePlayer(0.01)');
    assert.equal(c.run('playerBullets.length'), 1);
    c.run('updatePlayer(0.2)');
    assert.equal(c.run('playerBullets.length'), 1);
    c.run('updatePlayer(0.16)');
    assert.equal(c.run('playerBullets.length'), 2);
    c.sendTouch('btn-fire', 'touchend', [], [fire]);
    c.run('updatePlayer(0.5)');
    assert.equal(c.run('playerBullets.length'), 2);
});

test('blur, hiding the page, and canceled touches discard an unconsumed fire press', () => {
    for (const id of ['btn-fire', 'game']) {
        for (const reason of ['blur', 'hidden', 'touchcancel']) {
            const c = controls();
            c.run('beginGame()');
            const fire = c.touch(1, 500, id);
            c.sendTouch(id, 'touchstart', [fire], [fire]);
            if (reason === 'touchcancel') c.sendTouch(id, 'touchcancel', [], [fire]);
            else {
                c.sendTouch(id, 'touchend', [], [fire]);
                if (reason === 'blur') c.window.dispatch('blur');
                else {
                    c.document.hidden = true;
                    c.document.dispatch('visibilitychange');
                }
            }
            assert.equal(c.held(' '), false, `${id}: ${reason}`);
            c.run('updatePlayer(0.5)');
            assert.equal(c.run('playerBullets.length'), 0, `${id}: ${reason}`);
        }
    }
});

test('canceling a Fire touch preserves movement and fire held by other sources', () => {
    const c = controls();
    c.run('beginGame()');
    const fire = c.touch(1, 500, 'btn-fire');
    const left = c.touch(2, 20, 'btn-left');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.sendTouch('btn-left', 'touchstart', [fire, left], [left]);
    c.keyboard('keydown', ' ', 'Space');
    c.sendTouch('btn-fire', 'touchcancel', [left], [fire]);
    assert.equal(c.held(' '), true);
    assert.equal(c.held('ArrowLeft'), true);
    c.run('updatePlayer(0.01)');
    assert.equal(c.run('playerBullets.length'), 1);
    c.keyboard('keyup', ' ', 'Space');
    c.sendTouch('btn-left', 'touchend', [], [left]);
    c.run('updatePlayer(0.5)');
    assert.equal(c.run('playerBullets.length'), 1);
});

test('canceling a movement finger does not erase a released Fire tap awaiting a frame', () => {
    const c = controls();
    c.run('beginGame()');
    const left = c.touch(1, 20, 'btn-left');
    const fire = c.touch(2, 500, 'btn-fire');
    c.sendTouch('btn-left', 'touchstart', [left], [left]);
    c.sendTouch('btn-fire', 'touchstart', [left, fire], [fire]);
    c.sendTouch('btn-fire', 'touchend', [left], [fire]);
    c.sendTouch('btn-left', 'touchcancel', [], [left]);
    assert.equal(c.held('ArrowLeft'), false);
    assert.equal(c.held(' '), false);
    c.run('updatePlayer(1 / 60)');
    assert.equal(c.run('playerBullets.length'), 1);
    c.run('updatePlayer(0.5)');
    assert.equal(c.run('playerBullets.length'), 1);
});

test('a queued Fire tap does not carry into the next level or a restarted game', () => {
    for (const transition of [
        'showLevelTransition(); continueToNextLevel()',
        'showGameOver(); beginGame()',
    ]) {
        const c = controls();
        c.run('beginGame()');
        const fire = c.touch(1, 500, 'btn-fire');
        c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
        c.sendTouch('btn-fire', 'touchend', [], [fire]);
        c.run(transition);
        c.run('updatePlayer(0.5)');
        assert.equal(c.run('playerBullets.length'), 0, transition);
        c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
        c.sendTouch('btn-fire', 'touchend', [], [fire]);
        c.run('updatePlayer(1 / 60)');
        assert.equal(c.run('playerBullets.length'), 1, transition);
    }
});

test('a remaining canvas finger takes over firing and starts a fresh swipe', () => {
    for (const endType of ['touchend', 'touchcancel']) {
        const c = controls();
        c.run('beginGame()');
        const one = c.touch(1, 200, 'game');
        const oneMoved = c.touch(1, 160, 'game');
        const two = c.touch(2, 400, 'game');
        const twoMoved = c.touch(2, 440, 'game');
        c.sendTouch('game', 'touchstart', [one], [one]);
        c.sendTouch('game', 'touchmove', [oneMoved], [oneMoved]);
        assert.equal(c.held('ArrowLeft'), true, endType);
        c.sendTouch('game', 'touchstart', [oneMoved, two], [two]);
        c.sendTouch('game', endType, [two], [oneMoved]);
        assert.equal(c.held(' '), true, endType);
        assert.equal(c.held('ArrowLeft'), false, endType);
        assert.equal(c.held('ArrowRight'), false, endType);
        c.run('updatePlayer(0.01)');
        assert.equal(c.run('playerBullets.length'), 1, endType);
        c.sendTouch('game', 'touchmove', [twoMoved], [twoMoved]);
        assert.equal(c.held('ArrowRight'), true, endType);
        c.sendTouch('game', 'touchend', [], [twoMoved]);
        assert.equal(c.held(' '), false, endType);
        assert.equal(c.held('ArrowRight'), false, endType);
        c.run('updatePlayer(0.5)');
        assert.equal(c.run('playerBullets.length'), 1, endType);
    }
});

test('swiping uses the canvas finger and preserves a separately held Fire button', () => {
    const c = controls();
    const fire = c.touch(1, 500, 'btn-fire');
    const start = c.touch(2, 200, 'game');
    const moved = c.touch(2, 240, 'game');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.sendTouch('game', 'touchstart', [fire, start], [start]);
    c.sendTouch('game', 'touchmove', [fire, moved], [moved]);
    assert.equal(c.held('ArrowRight'), true);
    assert.equal(c.held(' '), true);
    c.sendTouch('game', 'touchend', [fire], [moved]);
    assert.equal(c.held('ArrowRight'), false);
    assert.equal(c.held(' '), true);
});

test('ending a canvas touch preserves buttons held by other fingers', () => {
    const c = controls();
    const left = c.touch(1, 20, 'btn-left');
    const fire = c.touch(2, 500, 'btn-fire');
    const canvas = c.touch(3, 200, 'game');
    c.sendTouch('btn-left', 'touchstart', [left], [left]);
    c.sendTouch('btn-fire', 'touchstart', [left, fire], [fire]);
    c.sendTouch('game', 'touchstart', [left, fire, canvas], [canvas]);
    c.sendTouch('game', 'touchend', [left, fire], [canvas]);
    assert.equal(c.held('ArrowLeft'), true);
    assert.equal(c.held(' '), true);
});

test('canceling a canvas swipe releases its controls', () => {
    const c = controls();
    const start = c.touch(1, 200, 'game');
    const moved = c.touch(1, 160, 'game');
    c.sendTouch('game', 'touchstart', [start], [start]);
    c.sendTouch('game', 'touchmove', [moved], [moved]);
    assert.equal(c.held('ArrowLeft'), true);
    c.sendTouch('game', 'touchcancel', [], [moved]);
    assert.equal(c.held('ArrowLeft'), false);
    assert.equal(c.held(' '), false);
});

test('releasing a touch does not release the same control held on the keyboard', () => {
    const c = controls();
    const fire = c.touch(1, 500, 'btn-fire');
    c.keyboard('keydown', ' ', 'Space');
    c.sendTouch('btn-fire', 'touchstart', [fire], [fire]);
    c.sendTouch('btn-fire', 'touchend', [], [fire]);
    assert.equal(c.held(' '), true);
    c.keyboard('keyup', ' ', 'Space');
    assert.equal(c.held(' '), false);
});

test('uppercase movement keys work and release after Shift changes', () => {
    const c = controls();
    c.keyboard('keydown', 'A', 'KeyA');
    assert.equal(c.held('a'), true);
    c.keyboard('keyup', 'a', 'KeyA');
    assert.equal(c.held('a'), false);
    c.keyboard('keydown', 'D', 'KeyD');
    assert.equal(c.held('d'), true);
    c.keyboard('keyup', 'd', 'KeyD');
    assert.equal(c.held('d'), false);
});

test('losing focus clears keyboard and touch gestures without reviving a stale swipe', () => {
    const c = controls();
    const start = c.touch(1, 200, 'game');
    c.keyboard('keydown', 'ArrowLeft');
    c.sendTouch('game', 'touchstart', [start], [start]);
    c.window.dispatch('blur');
    assert.equal(c.held('ArrowLeft'), false);
    assert.equal(c.held(' '), false);
    const moved = c.touch(1, 240, 'game');
    c.sendTouch('game', 'touchmove', [moved], [moved]);
    assert.equal(c.held('ArrowRight'), false);
});

test('lifting one of two fingers on Fire keeps firing until both are released', () => {
    const c = controls();
    const one = c.touch(1, 490, 'btn-fire');
    const two = c.touch(2, 510, 'btn-fire');
    c.sendTouch('btn-fire', 'touchstart', [one], [one]);
    c.sendTouch('btn-fire', 'touchstart', [one, two], [two]);
    c.sendTouch('btn-fire', 'touchend', [two], [one]);
    assert.equal(c.held(' '), true);
    c.sendTouch('btn-fire', 'touchend', [], [two]);
    assert.equal(c.held(' '), false);
});

test('Start and Next Level release hidden button focus so Space can fire immediately', () => {
    const c = controls();
    for (const id of ['start-btn', 'level-btn', 'start-btn']) {
        const button = c.element(id);
        button.matches = selector => selector === 'button';
        button.closest = selector => selector === '.overlay' ? {} : null;
        button.blur = () => { c.document.activeElement = null; };
        c.document.activeElement = button;
        button.dispatch('click');
        c.keyboard('keydown', ' ', 'Space');
        assert.equal(c.held(' '), true, id);
        c.keyboard('keyup', ' ', 'Space');
        assert.equal(c.held(' '), false, id);
    }
});
