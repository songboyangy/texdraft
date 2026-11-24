import assert from 'node:assert/strict';
import { api, ApiError } from '../src/lib/api';

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('null', { status: 200 });
  assert.equal(await api.latestCompile('uncompiled-project'), null);
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api.deleteProject('test-project'), null);
  globalThis.fetch = async () => new Response('{"id":"sample"}', { status: 200 });
  assert.deepEqual(await api.project('sample'), { id: 'sample' });
  globalThis.fetch = async () => new Response('<html>proxy error</html>', { status: 200 });
  await assert.rejects(api.project('sample'), (e: unknown) => e instanceof ApiError && e.message === '服务器返回了无法识别的内容');
  globalThis.fetch = async () => new Response('{"error":"Project not found"}', { status: 404 });
  await assert.rejects(api.project('missing'), (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === 'Project not found');
  console.log('API regression checks passed: null, empty body, object, invalid JSON, HTTP error');
} finally {
  globalThis.fetch = originalFetch;
}
