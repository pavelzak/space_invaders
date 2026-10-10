const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');
const signing = require('../score-signing.js');

const source = readFileSync(join(__dirname, '..', 'score-signing.js'), 'utf8');
const entry = {
    id: 'ab12cd34-5678-4abc-8def-123456789abc', name: 'Pilot', score: 1230, level: 4,
};

function browser(crypto = webcrypto) {
    const context = vm.createContext({ crypto, TextEncoder });
    vm.runInContext(source, context);
    return context.SpaceInvadersSigning;
}

test('real HMAC signatures have the versioned wire format and verify', async () => {
    const signature = await signing.signSubmission(entry);
    assert.match(signature, /^v1:[0-9a-f]{64}$/);
    assert.equal(await signing.verifySubmission(entry, signature), true);
    assert.deepEqual(Object.keys(signing).sort(), ['signSubmission', 'verifySubmission']);
});

test('changing any submitted field invalidates its signature', async () => {
    const signature = await signing.signSubmission(entry);
    for (const changed of [
        { id: 'ab12cd34-5678-4abc-8def-123456789abd' },
        { name: 'Cheater' }, { score: 1231 }, { level: 5 },
    ]) {
        assert.equal(await signing.verifySubmission({ ...entry, ...changed }, signature), false);
    }
});

test('malformed signatures and unknown versions fail closed', async () => {
    const signature = await signing.signSubmission(entry);
    for (const malformed of [
        undefined, null, 123, {}, '', signature.slice(3), signature.slice(0, -1),
        signature + '0', signature.replace('v1:', 'v2:'), signature.toUpperCase(),
        'v1:' + 'z'.repeat(64), signature + '\n',
    ]) assert.equal(await signing.verifySubmission(entry, malformed), false);
    const changed = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    assert.equal(await signing.verifySubmission(entry, changed), false);
});

test('identical retry payloads produce identical signatures', async () => {
    const signatures = await Promise.all(Array.from({ length: 8 }, () => signing.signSubmission({ ...entry })));
    assert.equal(new Set(signatures).size, 1);
    assert.equal(await signing.signSubmission(JSON.parse(JSON.stringify(entry))), signatures[0]);
});

test('UUID case, surrounding name whitespace, and property order have one canonical signature', async () => {
    const signature = await signing.signSubmission(entry);
    const normalized = { level: entry.level, score: entry.score, name: '  Pilot\t', id: entry.id.toUpperCase() };
    assert.equal(await signing.signSubmission(normalized), signature);
    assert.equal(await signing.verifySubmission(normalized, signature), true);
});

test('Unicode names and delimiter characters are unambiguous UTF-8 payloads', async () => {
    for (const name of ['Павел', '小明🚀', 'A|B,"C\\D']) {
        const score = { ...entry, name };
        const signature = await signing.signSubmission(score);
        assert.equal(await browser().verifySubmission(score, signature), true);
        assert.equal(await signing.verifySubmission({ ...score, name: name + 'x' }, signature), false);
    }
});

test('classic browser scripts and CommonJS produce interoperable signatures', async () => {
    const client = browser();
    const clientSignature = await client.signSubmission(entry);
    const workerSignature = await signing.signSubmission(entry);
    assert.equal(clientSignature, workerSignature);
    assert.equal(await signing.verifySubmission(entry, clientSignature), true);
    assert.equal(await client.verifySubmission(entry, workerSignature), true);
});

test('the signing key is imported once, nonextractably, even for concurrent work', async () => {
    const imports = [];
    const client = browser({ subtle: {
        importKey(...args) {
            imports.push({ format: args[0], length: args[1].length, algorithm: args[2], extractable: args[3], usages: args[4] });
            return webcrypto.subtle.importKey(...args);
        },
        sign: webcrypto.subtle.sign.bind(webcrypto.subtle),
        verify: webcrypto.subtle.verify.bind(webcrypto.subtle),
    } });
    const signatures = await Promise.all(Array.from({ length: 5 }, () => client.signSubmission(entry)));
    assert.equal(await client.verifySubmission(entry, signatures[0]), true);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].format, 'raw');
    assert.equal(imports[0].length, 32);
    assert.equal(imports[0].extractable, false);
    assert.equal(imports[0].algorithm.name, 'HMAC');
    assert.equal(imports[0].algorithm.hash, 'SHA-256');
    assert.deepEqual(Array.from(imports[0].usages), ['sign', 'verify']);
});

test('unavailable Web Crypto cannot generate or approve a submission', async () => {
    const client = browser({});
    await assert.rejects(client.signSubmission(entry), /requires Web Crypto/);
    await assert.rejects(client.verifySubmission(entry, await signing.signSubmission(entry)), /requires Web Crypto/);
    assert.equal(await client.verifySubmission(entry, 'malformed'), false);
});

test('invalid field types cannot become ambiguous JSON signature payloads', async () => {
    for (const invalid of [null, {}, { ...entry, score: '1230' }, { ...entry, score: NaN },
        { ...entry, score: Infinity }, { ...entry, level: 1.5 }, { ...entry, id: 12 }, { ...entry, name: null }]) {
        await assert.rejects(signing.signSubmission(invalid), { name: 'TypeError' });
    }
});
