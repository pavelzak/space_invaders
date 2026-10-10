const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the real gameplay code with rendering, audio, and the frame loop disabled.
// Each test starts a fresh game and advances its clock explicitly.
function game() {
    const elements = new Map();
    const element = () => ({
        textContent: '', innerHTML: '', value: '',
        classList: { add() {}, remove() {} },
        addEventListener() {}, setAttribute() {}, getContext() { return {}; },
    });
    const context = vm.createContext({
        window: { addEventListener() {} },
        document: {
            hidden: false,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            querySelectorAll() { return []; },
            createElement: element,
            addEventListener() {},
        },
        localStorage: { getItem() { return null; }, setItem() {} },
        requestAnimationFrame() {},
    });
    vm.runInContext(script, context);
    const run = code => vm.runInContext(code, context);
    run(`
        Math.random = () => 0.5;
        beginGame();
        playerInvuln = 0;
        alienFireTimer = 1e9;
        diveTimer = -1e9;
    `);
    return run;
}

test('a missed dive crosses the player, exits, and returns to its moving slot', () => {
    const run = game();
    run(`
        aliens = [createAlien(100, 100, 0), createAlien(200, 100, 1)];
        triggerDive();
        const diver = aliens[1];
        diver.x = 20;
        diver.y = PLAYER_Y - ALIEN_H - 1;
        player.x = 500;
        update(0.05);
    `);
    assert.equal(run('lives'), 3);
    assert.equal(run('diver.flight'), 'diving');
    assert.equal(run('aliens[0].y'), 100);
    assert.notEqual(run('diver.x'), run('diver.homeX'));
    run('for (let i = 0; i < 60 && diver.flight === "diving"; i++) update(0.05);');
    assert.equal(run('diver.flight'), 'returning');
    assert.equal(run('diver.y + diver.h'), 0);
    assert.equal(run('lives'), 3);
    run('for (let i = 0; i < 300 && diver.flight === "returning"; i++) update(0.05);');
    assert.equal(run('diver.flight'), 'formation');
    assert.equal(run('diver.x'), run('diver.homeX'));
    assert.equal(run('diver.y'), run('diver.homeY + formationDropAmount'));
    assert.equal(run('aliens.length'), 2);
    assert.equal(run('lives'), 3);
});

test('empty slots move together even when every alien is airborne', () => {
    const run = game();
    run(`
        aliens = [createAlien(100, 100, 0), createAlien(144, 100, 1)];
        aliens[0].flight = 'diving';
        aliens[1].flight = 'returning';
        updateFormation(0.05);
    `);
    assert(run('aliens[0].homeX > 100'));
    assert(run('Math.abs(aliens[1].homeX - aliens[0].homeX - 44) < 1e-9'));
    assert.equal(run('aliens[0].x'), 100);
    assert.equal(run('aliens[1].x'), 144);
});

test('edge bounce drops once and a new dive launches from the updated slot', () => {
    const run = game();
    run(`
        aliens = [createAlien(CW - 10 - ALIEN_W, 100, 0)];
        updateFormation(0.05);
        triggerDive();
    `);
    assert.equal(run('formationDir'), -1);
    assert.equal(run('formationDropAmount'), 16);
    assert.equal(run('aliens[0].homeY'), 100);
    assert.equal(run('aliens[0].y'), 116);
});

test('formation recycling costs no life and preserves active flights', () => {
    const run = game();
    run(`
        aliens = [createAlien(20, 100, 0), createAlien(100, 100, 1)];
        formationDropAmount = PLAYER_Y - ALIEN_H - 100;
        aliens[1].flight = 'returning';
        aliens[1].x = 300;
        aliens[1].y = -ALIEN_H;
        update(0);
    `);
    assert.equal(run('lives'), 3);
    assert.equal(run('formationDropAmount'), 0);
    assert.equal(run('aliens[0].y'), 100);
    assert.equal(run('aliens[1].flight'), 'returning');
    assert.equal(run('aliens[1].x'), 300);
    assert.equal(run('aliens[1].y'), -24);
});

test('actual alien contact costs one life and respects invulnerability', () => {
    for (const flight of ['formation', 'diving', 'returning']) {
        const run = game();
        run(`
            aliens = [createAlien(player.x, player.y, 0)];
            aliens[0].flight = '${flight}';
            checkCollisions();
        `);
        assert.equal(run('lives'), 2, flight);
        assert.equal(run('aliens[0].alive'), false, flight);
        run('aliens.push(createAlien(player.x, player.y, 1)); checkCollisions();');
        assert.equal(run('lives'), 2, flight);
        assert.equal(run('aliens[1].alive'), true, flight);
    }
});

test('returning aliens can be shot and never reappear after being destroyed', () => {
    const run = game();
    run(`
        aliens = [createAlien(100, 100, 0)];
        aliens[0].flight = 'returning';
        playerBullets = [{ x: 110, y: 110, w: BULLET_W, h: BULLET_H }];
        checkCollisions();
        for (let i = 0; i < 100; i++) {
            updateFormation(0.05);
            updateAliens(0.05);
        }
    `);
    assert.equal(run('aliens[0].alive'), false);
    assert.equal(run('score'), 40);
    assert.equal(run('aliens[0].x'), 100);
    assert.equal(run('aliens[0].y'), 100);
});

test('returning aliens finish docking before attacking again', () => {
    const run = game();
    run(`
        aliens = [createAlien(100, 100, 0)];
        aliens[0].flight = 'returning';
        aliens[0].y = -ALIEN_H;
        triggerDive();
        alienFire();
    `);
    assert.equal(run('aliens[0].flight'), 'returning');
    assert.equal(run('alienBullets.length'), 0);
    run('aliens[0].y = aliens[0].homeY; updateAliens(0);');
    assert.equal(run('aliens[0].flight'), 'formation');
    assert.equal(run('aliens[0].x'), 100);
    run('alienFire(); triggerDive();');
    assert.equal(run('alienBullets.length'), 1);
    assert.equal(run('aliens[0].flight'), 'diving');
});

test('a returner catches its slot at the fastest configured formation speed', () => {
    const run = game();
    run(`
        startLevel(LEVELS.length);
        wave = totalWaves;
        spawnWave();
        diveTimer = -1e9;
        aliens = [createAlien(500, 100, 0)];
        aliens[0].flight = 'returning';
        aliens[0].x = 20;
        aliens[0].y = -ALIEN_H;
        for (let i = 0; i < 300 && aliens[0].flight === 'returning'; i++) {
            updateFormation(0.05);
            updateAliens(0.05);
        }
    `);
    assert.equal(run('aliens[0].flight'), 'formation');
    assert.equal(run('aliens[0].x'), run('aliens[0].homeX'));
    assert.equal(run('aliens[0].y'), run('aliens[0].homeY + formationDropAmount'));
});

test('last-life contact with the last alien ends the game without awarding victory', () => {
    const run = game();
    run(`
        startLevel(LEVELS.length);
        playerInvuln = 0;
        wave = totalWaves;
        lives = 1;
        aliens = [createAlien(player.x, player.y, 0)];
        aliens[0].flight = 'diving';
        update(0);
    `);
    assert.equal(run('lives'), 0);
    assert.equal(run('gameState'), 'gameOver');
});

test('every level and wave starts inside the arena with room to move', () => {
    const run = game();
    assert.equal(run('LEVELS.length'), 6);
    for (let level = 1; level <= run('LEVELS.length'); level++) {
        run(`startLevel(${level});`);
        for (let wave = 1; wave <= run('totalWaves'); wave++) {
            run(`wave = ${wave}; spawnWave();`);
            assert(run('aliens.every(a => a.x >= 10 && a.x + a.w <= CW - 10)'),
                `level ${level}, wave ${wave} starts offscreen`);
            const width = run('Math.max(...aliens.map(a => a.x + a.w)) - Math.min(...aliens.map(a => a.x))');
            assert(width <= 480, `level ${level}, wave ${wave} has no space to travel`);
            assert(run('aliens.every(a => a.y >= 0 && a.y + a.h < CH - 120)'), 'aliens spawn above the bunkers');
            assert(run('aliens.every((a, i) => aliens.slice(i + 1).every(b => !rectsOverlap(a.x, a.y, a.w, a.h, b.x, b.y, b.w, b.h)))'),
                `level ${level} has overlapping aliens`);
            if (level === 3) assert.equal(run('aliens.length'), 42);
        }
    }
});

test('full formations stay within bounds and traverse before each drop', () => {
    const run = game();
    for (let level = 1; level <= run('LEVELS.length'); level++) {
        run(`startLevel(${level});`);
        for (let wave = 1; wave <= run('totalWaves'); wave++) {
            for (const dt of [1 / 144, 1 / 60, 0.05]) {
                run(`
                    startLevel(${level});
                    wave = ${wave}; spawnWave();
                    diveTimer = -1e9;
                `);
                let lastDrop = 0;
                let lastTurn = -Infinity;
                let turns = 0;
                for (let frame = 0; frame < 8 / dt; frame++) {
                    run(`updateFormation(${dt}); updateAliens(${dt});`);
                    assert(run('aliens.every(a => a.x >= 10 - 1e-9 && a.x + a.w <= CW - 10 + 1e-9)'),
                        `level ${level}, wave ${wave}, dt ${dt} leaves the arena`);
                    const drop = run('formationDropAmount');
                    if (drop !== lastDrop) {
                        assert.equal(drop - lastDrop, 16);
                        assert(frame * dt - lastTurn >= 0.5, 'formation reverses again without crossing the arena');
                        lastTurn = frame * dt;
                        lastDrop = drop;
                        turns++;
                    }
                }
                assert(turns > 0, 'formation must keep moving and reverse at an edge');
            }
        }
    }
});

test('clearing every wave progresses through all levels to victory', () => {
    const run = game();
    for (let level = 1; level <= run('LEVELS.length'); level++) {
        assert.equal(run('level'), level);
        const waves = run('totalWaves');
        for (let wave = 1; wave <= waves; wave++) {
            assert.equal(run('wave'), wave);
            run('aliens.forEach(a => a.alive = false); update(0);');
            if (wave < waves) {
                assert.equal(run('gameState'), 'playing');
                assert(run('aliens.length > 0 && aliens.every(a => a.alive)'));
            }
        }
        if (level < run('LEVELS.length')) {
            assert.equal(run('gameState'), 'levelTransition');
            run('continueToNextLevel();');
        }
    }
    assert.equal(run('gameState'), 'victory');
    assert.equal(run('lives'), 3);
});

test('new levels use distinct formations and increase the challenge gradually', () => {
    const run = game();
    const shapes = new Set();
    let previousSpeed = 0;
    let previousFireInterval = Infinity;
    for (let level = 1; level <= run('LEVELS.length'); level++) {
        run(`startLevel(${level});`);
        shapes.add(run('JSON.stringify(aliens.map(a => [a.x, a.y]))'));
        assert(run('formationSpeed') > previousSpeed);
        assert(run('alienFireInterval') < previousFireInterval);
        previousSpeed = run('formationSpeed');
        previousFireInterval = run('alienFireInterval');
        run('wave = totalWaves; spawnWave();');
        assert(run('formationSpeed * 3 < ALIEN_RETURN_SPEED'), 'returners must be able to catch the fleet');
    }
    assert.equal(shapes.size, 6);
});

test('respawning a wave does not keep multiplying its difficulty', () => {
    const run = game();
    run('startLevel(LEVELS.length); wave = totalWaves; spawnWave();');
    const speed = run('formationSpeed');
    const interval = run('alienFireInterval');
    run('spawnWave(); spawnWave();');
    assert.equal(run('formationSpeed'), speed);
    assert.equal(run('alienFireInterval'), interval);
});

test('a slow frame still registers a shot crossing a descending alien', () => {
    const run = game();
    run(`
        formationSpeed = 0;
        bunkers = [];
        aliens = [createAlien(100, 300, 0)];
        aliens[0].flight = 'returning';
        aliens[0].y = 100;
        playerBullets = [{ x: 110, y: 126, w: BULLET_W, h: BULLET_H }];
        update(0.05);
    `);
    assert.equal(run('aliens[0].alive'), false);
    assert.equal(run('score'), 40);
});

test('a slow frame cannot skip a surviving bunker block', () => {
    const run = game();
    run(`
        aliens = [createAlien(300, 100, 0)];
        bunkers = [{ x: 100, y: 300, blocks: [{ bx: 100, by: 300, hp: 3 }] }];
        playerBullets = [{ x: 101, y: 306, w: BULLET_W, h: BULLET_H }];
        update(0.05);
    `);
    assert.equal(run('bunkers[0].blocks[0].hp'), 2);
    assert.equal(run('playerBullets.length'), 0);
});

test('faster refresh rates do not get the full 60Hz dive chance on each frame', () => {
    const run = game();
    run('diveTimer = 4; Math.random = () => 0.01; updateFormation(1 / 144);');
    assert(run('aliens.every(a => a.flight === "formation")'));
    run('updateFormation(1 / 60);');
    assert.equal(run('aliens.filter(a => a.flight === "diving").length'), 1);
});
