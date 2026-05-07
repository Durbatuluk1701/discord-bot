/**
 * Tests for src/util/privateApi.ts
 *
 * Validates that privateApiGet and privateApiPost:
 *  1. Build the correct URL (matching HttpManager.resolveUrl output)
 *  2. Send the private API token as the Authorization header — NOT the
 *     statsfm bearer token that HttpManager would inject instead
 *  3. Serialize the request body and Content-Type header correctly (POST)
 *  4. Append query parameters to the URL correctly
 *  5. Throw on non-OK responses with a detailed error message
 *  6. Throw when privateApiToken is not configured
 *
 * Background: statsfm.js HttpManager.resolveRequest builds fetch headers as
 *   { ...request.headers, ...libraryHeaders }
 * where libraryHeaders always contains Authorization: Bearer <accessToken>.
 * This means any custom Authorization passed through api.http.get/post is
 * silently overwritten. The privateApiGet/privateApiPost helpers bypass
 * HttpManager and call fetch directly, preserving the private API token.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { container } from 'tsyringe';
import { Config } from '../util/Config';
import { privateApiGet, privateApiPost } from '../util/privateApi';

// ---------------------------------------------------------------------------
// Minimal stub for Config — only the fields privateApi.ts needs
// ---------------------------------------------------------------------------
const PRIVATE_TOKEN = 'private-bot-secret-token';
const API_URL = 'https://api.stats.fm';
const API_VERSION = '1';

function makeConfig(privateApiToken?: string) {
  return {
    statsfm: { http: { apiUrl: API_URL, version: API_VERSION } },
    privateApiToken
  } as unknown as Config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type CapturedRequest = { url: string; init: RequestInit };

let originalFetch: typeof globalThis.fetch;

function mockFetch(response: unknown, status = 200): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async (
    url: string,
    init?: RequestInit
  ): Promise<Response> => {
    captured.push({ url, init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => response,
      text: async () => JSON.stringify(response)
    } as unknown as Response;
  };
  return captured;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('privateApiGet', () => {
  beforeEach(() => {
    container.clearInstances();
    container.registerInstance(Config, makeConfig(PRIVATE_TOKEN));
  });

  afterEach(() => {
    container.clearInstances();
    restoreFetch();
  });

  test('builds the correct versioned URL', async () => {
    const captured = mockFetch({ data: 'ok' });

    await privateApiGet('/some/path');

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, `${API_URL}/v${API_VERSION}/some/path`);
  });

  test('sets Authorization header to private API token (not Bearer)', async () => {
    const captured = mockFetch({ data: 'ok' });

    await privateApiGet('/some/path');

    const headers = captured[0].init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], PRIVATE_TOKEN);
    // Confirm it is NOT the bearer format that HttpManager would inject
    assert.ok(!headers['Authorization'].startsWith('Bearer '));
  });

  test('appends query parameters to the URL', async () => {
    const captured = mockFetch([]);

    await privateApiGet('/top-listeners/artists/123', { range: 'weeks', limit: 10 });

    const url = new URL(captured[0].url);
    assert.equal(url.pathname, `/v${API_VERSION}/top-listeners/artists/123`);
    assert.equal(url.searchParams.get('range'), 'weeks');
    assert.equal(url.searchParams.get('limit'), '10');
  });

  test('returns parsed JSON body on success', async () => {
    mockFetch({ result: 42 });

    const result = await privateApiGet<{ result: number }>('/foo');

    assert.deepEqual(result, { result: 42 });
  });

  test('throws with status and body on non-OK response', async () => {
    mockFetch({ message: 'Forbidden' }, 403);

    await assert.rejects(
      () => privateApiGet('/restricted'),
      (err: Error) => {
        assert.ok(err.message.includes('403'));
        assert.ok(err.message.includes('Forbidden'));
        return true;
      }
    );
  });

  test('throws when privateApiToken is not configured', async () => {
    container.clearInstances();
    container.registerInstance(Config, makeConfig(undefined));

    await assert.rejects(() => privateApiGet('/some/path'), /Private API token is not configured/);
  });
});

describe('privateApiPost', () => {
  beforeEach(() => {
    container.clearInstances();
    container.registerInstance(Config, makeConfig(PRIVATE_TOKEN));
  });

  afterEach(() => {
    container.clearInstances();
    restoreFetch();
  });

  test('sends POST method with correct URL', async () => {
    const captured = mockFetch({ success: true });

    await privateApiPost('/member-cache', ['user1', 'user2']);

    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, `${API_URL}/v${API_VERSION}/member-cache`);
    assert.equal(captured[0].init.method, 'POST');
  });

  test('sets Authorization header to private API token (not Bearer)', async () => {
    const captured = mockFetch({ success: true });

    await privateApiPost('/member-cache', ['user1']);

    const headers = captured[0].init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], PRIVATE_TOKEN);
    assert.ok(!headers['Authorization'].startsWith('Bearer '));
  });

  test('serializes body as JSON and sets Content-Type', async () => {
    const captured = mockFetch({ success: true });
    const payload = ['user1', 'user2', 'user3'];

    await privateApiPost('/member-cache', payload);

    const headers = captured[0].init.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(captured[0].init.body, JSON.stringify(payload));
  });

  test('appends query parameters to the URL', async () => {
    const captured = mockFetch({ success: true });

    await privateApiPost('/member-cache', ['user1'], { batch: true });

    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('batch'), 'true');
  });

  test('returns parsed JSON body on success', async () => {
    mockFetch({ id: 'abc' });

    const result = await privateApiPost<{ id: string }>('/foo', { x: 1 });

    assert.deepEqual(result, { id: 'abc' });
  });

  test('throws with status and body on non-OK response', async () => {
    mockFetch({ message: 'Unauthorized' }, 401);

    await assert.rejects(
      () => privateApiPost('/protected', {}),
      (err: Error) => {
        assert.ok(err.message.includes('401'));
        return true;
      }
    );
  });
});

describe('HttpManager header overwrite (demonstrates root cause)', () => {
  test('HttpManager.resolveRequest puts library Authorization after caller headers', async () => {
    // The public @statsfm/statsfm.js API does not export HttpManager directly.
    // We access the internal dist path here solely to inspect the header-merging
    // behaviour of resolveRequest in a white-box test — this is intentional and
    // acceptable in a test-only context. If the library restructures its internals
    // this test will fail loudly, which is the desired signal.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HttpManager } = require('@statsfm/statsfm.js/dist/lib/http/HttpManager');

    const STATSFM_TOKEN = 'statsfm-access-token';
    const CUSTOM_TOKEN = 'my-custom-private-token';

    const mgr = new HttpManager({
      http: {
        apiUrl: 'https://api.stats.fm',
        version: '1',
        userAgentAppendix: 'test',
        retries: 0
      },
      auth: { accessToken: STATSFM_TOKEN }
    });

    // Simulate what the old whoknows code was doing:
    // api.http.get('/private/...', { headers: { Authorization: CUSTOM_TOKEN } })
    const { fetchOptions } = await mgr.resolveRequest({
      fullRoute: '/private/test',
      method: 'GET',
      headers: { Authorization: CUSTOM_TOKEN },
      versioned: true
    });

    const actualAuth = (fetchOptions.headers as Record<string, string>)['Authorization'];

    // The library OVERWRITES the caller's Authorization with its own Bearer token
    assert.equal(
      actualAuth,
      `Bearer ${STATSFM_TOKEN}`,
      'HttpManager must overwrite custom Authorization with its own Bearer token'
    );
    assert.notEqual(
      actualAuth,
      CUSTOM_TOKEN,
      'The custom private token must NOT survive through HttpManager'
    );
  });
});
