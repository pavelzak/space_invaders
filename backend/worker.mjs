import signing from '../score-signing.js';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_STORED_SCORES = 100;
const MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^v1:[0-9a-f]{64}$/;

class HttpError extends Error {
    constructor(status, message, headers = {}) {
        super(message);
        this.status = status;
        this.headers = headers;
    }
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validScore(value) {
    return isObject(value)
        && typeof value.id === 'string' && UUID.test(value.id)
        && typeof value.name === 'string' && value.name.trim().length > 0
        && value.name.trim().length <= 12 && !/[\u0000-\u001f\u007f]/.test(value.name)
        && Number.isSafeInteger(value.score) && value.score >= 0 && value.score <= 100000
        && Number.isInteger(value.level) && value.level >= 1 && value.level <= 6;
}

function normalizeSubmission(value) {
    if (!validScore(value)
        || Object.keys(value).some(key => !['id', 'name', 'score', 'level', 'signature'].includes(key))) {
        throw new HttpError(400, 'Expected a UUID, a name of 1–12 characters, a score from 0–100000, and a level from 1–6.');
    }
    return { id: value.id.toLowerCase(), name: value.name.trim(), score: value.score, level: value.level, signature: value.signature };
}

function rankScores(scores) {
    return [...scores].sort((a, b) => b.score - a.score || b.level - a.level
        || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

function storageUnavailable() {
    return new HttpError(503, 'Leaderboard storage is temporarily unavailable.', { 'Retry-After': '5' });
}

async function readScores(database) {
    // Without a D1 Session, reads go to the primary rather than a possibly stale replica.
    const row = await database.prepare('SELECT revision, data FROM leaderboard_state WHERE id = 1').first();
    if (row === null) return { scores: [], revision: null };
    if (!isObject(row) || !Number.isSafeInteger(row.revision) || row.revision < 1
        || typeof row.data !== 'string' || new TextEncoder().encode(row.data).length > MAX_STATE_BYTES) {
        throw storageUnavailable();
    }
    let state;
    try {
        state = JSON.parse(row.data);
    } catch {
        throw storageUnavailable();
    }
    if (!isObject(state) || state.version !== 1 || !Array.isArray(state.scores)
        || state.scores.length > MAX_STORED_SCORES) throw storageUnavailable();
    const ids = new Set();
    for (const score of state.scores) {
        if (!validScore(score) || score.id !== score.id.toLowerCase() || score.name !== score.name.trim()
            || typeof score.date !== 'string' || !Number.isFinite(Date.parse(score.date))
            || new Date(score.date).toISOString() !== score.date || ids.has(score.id)
            || ('signature' in score && (typeof score.signature !== 'string' || !SIGNATURE.test(score.signature)))
            || Object.keys(score).some(key => !['id', 'name', 'score', 'level', 'date', 'signature'].includes(key))) {
            throw storageUnavailable();
        }
        ids.add(score.id);
    }
    return { scores: rankScores(state.scores), revision: row.revision };
}

async function readSubmission(request) {
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'Use Content-Type: application/json.');
    }
    const length = request.headers.get('Content-Length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
        throw new HttpError(413, 'Score submission is too large.');
    }
    if (!request.body) throw new HttpError(400, 'A JSON score submission is required.');
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new HttpError(413, 'Score submission is too large.');
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'Could not read the score submission.');
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new HttpError(400, 'Score submission must be valid JSON.');
    }
    return normalizeSubmission(value);
}

async function saveScore(database, submission, pause) {
    // Keep the same record across conflicts and request retries. Dates come from the server.
    const entry = { ...submission, date: new Date().toISOString() };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const { scores, revision } = await readScores(database);
        const existing = scores.find(score => score.id === entry.id);
        if (existing) {
            if (existing.name !== entry.name || existing.score !== entry.score || existing.level !== entry.level) {
                throw new HttpError(409, 'This submission ID already belongs to a different score.');
            }
            return scores.slice(0, 10);
        }
        const merged = rankScores([...scores, entry]).slice(0, MAX_STORED_SCORES);
        if (revision === Number.MAX_SAFE_INTEGER) throw storageUnavailable();
        const data = JSON.stringify({ version: 1, scores: merged });
        if (new TextEncoder().encode(data).length > MAX_STATE_BYTES) throw storageUnavailable();
        // The revision check and write are one atomic SQL statement. A concurrent
        // first creation also changes zero rows, so both cases retry the latest state.
        const statement = revision === null
            ? database.prepare('INSERT INTO leaderboard_state (id, revision, data) VALUES (1, 1, ?) ON CONFLICT(id) DO NOTHING').bind(data)
            : database.prepare('UPDATE leaderboard_state SET data = ?, revision = revision + 1 WHERE id = 1 AND revision = ?').bind(data, revision);
        const result = await statement.run();
        if (result?.success !== true || ![0, 1].includes(result.meta?.changes)) throw storageUnavailable();
        if (result.meta.changes === 1) return merged.slice(0, 10);
        if (attempt + 1 < MAX_ATTEMPTS) await pause(25 * 2 ** attempt + Math.floor(Math.random() * 25));
    }
    throw new HttpError(503, 'Leaderboard is busy. Please retry the same submission.', { 'Retry-After': '2' });
}

export function createWorker({ pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    return {
        async fetch(request, env) {
            const origin = request.headers.get('Origin');
            const allowed = Boolean(origin && origin === env.ALLOWED_ORIGIN);
            const headers = {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Vary': 'Origin',
            };
            if (allowed) {
                headers['Access-Control-Allow-Origin'] = origin;
                headers['Access-Control-Expose-Headers'] = 'Retry-After';
            }
            const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
                status, headers: { ...headers, ...extra },
            });
            try {
                if (new URL(request.url).pathname !== '/scores') return json({ error: 'Not found.' }, 404);
                if (request.method === 'OPTIONS') {
                    if (!allowed) throw new HttpError(403, 'This origin cannot submit scores.');
                    return new Response(null, {
                        status: 204,
                        headers: {
                            ...headers,
                            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                            'Access-Control-Allow-Headers': 'Content-Type',
                            'Access-Control-Max-Age': '600',
                        },
                    });
                }
                if (request.method === 'GET') {
                    const { scores } = await readScores(env.LEADERBOARD_DB);
                    return json({ scores: scores.slice(0, 10) });
                }
                if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST, OPTIONS' });
                if (!allowed) throw new HttpError(403, 'This origin cannot submit scores.');
                // Cloudflare supplies this header at its edge; never use a body field or X-Forwarded-For.
                // Shared IPs share this approximate limit. No address is stored in the leaderboard.
                const { success } = await env.SCORE_RATE_LIMITER.limit({
                    key: `submit:${request.headers.get('CF-Connecting-IP') || 'unknown'}`,
                });
                if (!success) throw new HttpError(429, 'Too many submissions. Please try again later.', { 'Retry-After': '60' });
                const submission = await readSubmission(request);
                // This shared browser key deters casual edits; it cannot prove a score was earned.
                // Verify before any D1 access, including the duplicate-submission lookup.
                if (typeof submission.signature !== 'string' || !SIGNATURE.test(submission.signature)
                    || !await signing.verifySubmission(submission, submission.signature)) {
                    throw new HttpError(403, 'Reload the game and submit again. The score signature is missing or invalid.');
                }
                const scores = await saveScore(env.LEADERBOARD_DB, submission, pause);
                return json({ scores });
            } catch (error) {
                if (error instanceof HttpError) return json({ error: error.message }, error.status, error.headers);
                return json({ error: 'Leaderboard is temporarily unavailable.' }, 503, { 'Retry-After': '5' });
            }
        },
    };
}

export default createWorker();
