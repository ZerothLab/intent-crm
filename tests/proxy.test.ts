import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedProxies } from '../apps/api/src/proxy.js';
import { createApi } from '../apps/api/src/index.js';
import { DomainError } from '../packages/domain/src/index.js';

test('proxy trust requires explicit addresses and refuses trust-all or ambiguous configuration', () => {
    assert.equal(trustedProxies(''), false);
    assert.deepEqual(trustedProxies('127.0.0.1, ::1/128, 10.1.0.0/16'), ['127.0.0.1', '::1/128', '10.1.0.0/16']);
    for (const value of ['true', '1', 'loopback', '*', 'proxy.internal', '0.0.0.0/0', '::/0', '::ffff:0.0.0.0/96', '::ffff:0:0/96', '0:0:0:0:0:ffff:c000:201/120', '10.0.0.1/33', '::1/129', '::1/64/1', 'fe80::1%en0', '10.0.0.1,', '10.0.0.1/-1'])
        assert.throws(() => trustedProxies(value), /INTENT_TRUSTED_PROXIES/, value);
});

test('HTTP login uses the nearest untrusted client and ignores forged forwarding headers by default', async () => {
    const keys = ['DATABASE_URL', 'NODE_ENV', 'INTENT_AUTH_MODE', 'INTENT_PUBLIC_ORIGIN', 'INTENT_TRUSTED_PROXIES'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused', NODE_ENV: 'test', INTENT_AUTH_MODE: 'password', INTENT_PUBLIC_ORIGIN: 'http://localhost:5173' });
    try {
        for (const [proxies, forwarded, expected] of [
            ['', '198.51.100.10', '127.0.0.1'],
            ['10.0.0.0/8', '198.51.100.10', '127.0.0.1'],
            ['127.0.0.1', '198.51.100.10', '198.51.100.10'],
            ['127.0.0.1', 'forged, 198.51.100.11', '198.51.100.11'],
            ['127.0.0.1,10.0.0.0/8', 'forged, 198.51.100.12, 10.1.2.3', '198.51.100.12'],
            ['127.0.0.1', '', '127.0.0.1'],
        ]) {
            process.env.INTENT_TRUSTED_PROXIES = proxies!;
            const server = await createApi();
            let client = '';
            server.identity.login = async (_input, key) => { client = key; throw new DomainError('UNAUTHENTICATED', 401, 'Invalid credentials.'); };
            try {
                await server.app.listen(0, '127.0.0.1');
                const response = await fetch(`${await server.app.getUrl()}/api/auth/login`, {
                    method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', 'x-forwarded-for': forwarded!, forwarded: 'for=203.0.113.50' },
                    body: JSON.stringify({ workspaceId: 'example', email: 'owner@example.test', password: 'test-only-password' }),
                });
                assert.equal(response.status, 401);
                assert.equal(client, expected);
                if (!forwarded) {
                    server.identity.login = async () => { throw new DomainError('RATE_LIMITED', 429, 'Too many sign-in attempts. Try again in 15 minutes.', 900); };
                    const limited = await fetch(`${await server.app.getUrl()}/api/auth/login`, {
                        method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
                        body: JSON.stringify({ workspaceId: 'example', email: 'owner@example.test', password: 'test-only-password' }),
                    });
                    assert.equal(limited.status, 429);
                    assert.equal(limited.headers.get('retry-after'), '900');
                }
            } finally { await server.app.close(); await server.db.close(); }
        }
    } finally {
        for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    }
});
