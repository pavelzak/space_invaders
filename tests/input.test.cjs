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
    const held = key => !!vm.runInContext(`keys[${JSON.stringify(key)}]`, context);
    const touch = (identifier, clientX, id) => ({ identifier, clientX, target: element(id) });
    const sendTouch = (id, type, touches, changedTouches) => element(id).dispatch(type, {
        touches, targetTouches: touches.filter(t => t.target === element(id)), changedTouches,
    });
    const keyboard = (type, key, code = key) => window.dispatch(type, {
        key, code, target: document.activeElement || window,
    });
    return { window, document, element, held, touch, sendTouch, keyboard };
}

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
