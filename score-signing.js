(function (root, factory) {
    'use strict';
    const signing = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = signing;
    else root.SpaceInvadersSigning = signing;
})(globalThis, function (root) {
    'use strict';

    // This shared browser key is public and extractable. The shuffled, masked
    // bytes only deter casual tampering; signatures do not prove a score was earned.
    const maskedBytes = [254, 118, 252, 31, 204, 163, 190, 18,
        241, 46, 156, 235, 238, 241, 188, 21,
        158, 179, 0, 137, 220, 0, 124, 223,
        27, 31, 9, 200, 150, 238, 55, 87];
    let importedKey;

    function cryptoSubtle() {
        const subtle = root.crypto?.subtle;
        if (!subtle) throw new Error('Score signing requires Web Crypto on HTTPS or localhost.');
        return subtle;
    }

    function keyFor(subtle) {
        if (!importedKey) {
            const bytes = new Uint8Array(maskedBytes.length);
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = maskedBytes[(i * 13 + 7) % bytes.length] ^ ((i * 29 + 173) & 255);
            }
            importedKey = subtle.importKey('raw', bytes,
                { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
                .finally(() => bytes.fill(0));
        }
        return importedKey;
    }

    function payload(entry) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.name !== 'string'
            || !Number.isSafeInteger(entry.score) || !Number.isSafeInteger(entry.level)) {
            throw new TypeError('Expected a score ID, name, integer score, and integer level.');
        }
        return new TextEncoder().encode(JSON.stringify([
            'space-invaders:score:v1', entry.id.toLowerCase(), entry.name.trim(), entry.score, entry.level,
        ]));
    }

    async function signSubmission(entry) {
        const data = payload(entry);
        const subtle = cryptoSubtle();
        const signature = await subtle.sign('HMAC', await keyFor(subtle), data);
        return 'v1:' + Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function verifySubmission(entry, signature) {
        if (typeof signature !== 'string' || !/^v1:[0-9a-f]{64}$/.test(signature)) return false;
        const data = payload(entry);
        const subtle = cryptoSubtle();
        const bytes = new Uint8Array(32);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(signature.slice(3 + i * 2, 5 + i * 2), 16);
        return subtle.verify('HMAC', await keyFor(subtle), bytes, data);
    }

    return Object.freeze({ signSubmission, verifySubmission });
});
