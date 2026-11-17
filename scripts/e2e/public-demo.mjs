// 公开体验站（PUBLIC_DEMO）端到端测试：站点配置、按 IP 限制注册、人机验证、项目数 / 项目大小配额、
// 编译排队与每人编译频率、服务器 CLI Agent 与自定义模型地址被强制关闭。
// 用法：服务端以下列环境变量启动（seed.mjs 已运行，a@test.dev 是管理员）：
//   PUBLIC_DEMO=true SOURCE_URL=https://example.com/texdraft COMPILE_CONCURRENCY=1 COMPILES_PER_MINUTE=3
//   MAX_PROJECTS_PER_USER=3 MAX_PROJECT_BYTES=300000 REGISTRATIONS_PER_IP_PER_DAY=2 ALLOW_LOCAL_AGENT_SETUP=true
// 可选：TURNSTILE=pass|fail 时服务端需配置 Cloudflare 的测试密钥（site 1x00000000000000000000AA，
//   secret 1x0000000000000000000000000000000AA 总是通过 / 2x0000000000000000000000000000000AA 总是失败）。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// fflate 是服务端依赖：从 apps/server 解析
const { zipSync, strToU8 } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('fflate');

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const TURNSTILE = process.env.TURNSTILE ?? '';
const ok = (m) => console.log(`ok - ${m}`);
const run = Date.now().toString(36);
// 每次运行用不同的“客户端 IP”（经 CF-Connecting-IP 传入，服务端在本机回环时采信）
const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

function session(clientIp = ip) {
  const s = {
    cookie: '',
    async req(method, path, body, extraHeaders = {}) {
      const isForm = body instanceof FormData;
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          'accept-language': 'en',
          'cf-connecting-ip': clientIp,
          ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(s.cookie ? { cookie: s.cookie } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
      const set = r.headers.get('set-cookie');
      if (set?.startsWith('tp_session=')) s.cookie = set.split(';')[0];
      const text = await r.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: r.status, data };
    },
  };
  return s;
}
const register = async (n, extra = {}) => {
  const s = session();
  const r = await s.req('POST', '/api/auth/register', { email: `${n}-${run}@demo.test`, name: n, password: 'password123', ...extra });
  return { s, r };
};
const token = TURNSTILE === 'pass' || TURNSTILE === 'fail' ? { turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' } : {};

// 空数据库（例如开启人机验证后 seed.mjs 无法注册）：先注册管理员 a@test.dev，后面的测试账号才是普通用户
if ((await session().req('GET', '/api/auth/config')).data.firstUser) {
  const r = await session('10.255.255.254').req('POST', '/api/auth/register', { email: 'a@test.dev', name: 'Admin', password: 'password123', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

// ---- 站点配置
const cfg = (await session().req('GET', '/api/auth/config')).data;
assert.equal(cfg.demo, true);
assert.equal(cfg.sourceUrl, 'https://example.com/texdraft');
assert.equal(cfg.notice, 'default');
ok('site config exposes demo mode, source link and notice');

// ---- 人机验证
if (TURNSTILE) {
  assert.ok(cfg.turnstileSiteKey, 'turnstile site key exposed');
  const missing = await register('nocaptcha');
  assert.equal(missing.r.status, 400, JSON.stringify(missing.r.data));
  if (TURNSTILE === 'fail') {
    assert.equal((await register('badcaptcha', token)).r.status, 400);
    console.log('PUBLIC DEMO TURNSTILE FAIL TEST PASSED');
    process.exit(0);
  }
  ok('registration requires a Turnstile token');
}

// ---- 每个 IP 每天最多注册 2 个账号
const a = await register('alice', token);
assert.equal(a.r.status, 200, JSON.stringify(a.r.data));
const b = await register('bob', token);
assert.equal(b.r.status, 200, JSON.stringify(b.r.data));
const c = await register('carol', token);
assert.equal(c.r.status, 429, JSON.stringify(c.r.data));
assert.match(c.r.data.error ?? c.r.data.message, /today/);
const other = session(`${ip}9`);
assert.equal((await other.req('POST', '/api/auth/register', { email: `dave-${run}@demo.test`, name: 'dave', password: 'password123', ...token })).status, 200);
ok('registrations are limited per IP per day; other IPs are unaffected');

// ---- 示例项目：每位新用户自动获得一份（中文短文 + 公式 + 参考文献）
const alice = a.s;
const mine = (await alice.req('GET', '/api/projects')).data;
assert.equal(mine.length, 1, JSON.stringify(mine));
assert.match(mine[0].name, /TeXdraft/);
const sampleFiles = (await alice.req('GET', `/api/projects/${mine[0].id}/files`)).data.map((f) => f.path).sort();
assert.deepEqual(sampleFiles, ['main.tex', 'refs.bib']);
assert.equal((await alice.req('POST', '/api/projects/sample', {})).data.id, mine[0].id, 'opening the sample returns the existing one');
ok('new accounts get their own sample project');

// ---- 项目数上限（3 个，含示例项目）
const p1 = (await alice.req('POST', '/api/projects', { name: 'demo one' })).data;
const p2 = (await alice.req('POST', '/api/projects', { name: 'demo two' })).data;
assert.ok(p1.id && p2.id);
const p3 = await alice.req('POST', '/api/projects', { name: 'demo three' });
assert.equal(p3.status, 403, JSON.stringify(p3.data));
const zip = new FormData();
zip.append('file', new Blob([zipSync({ 'main.tex': strToU8('\\documentclass{article}\\begin{document}x\\end{document}') })]), 'p.zip');
assert.equal((await alice.req('POST', '/api/projects/import', zip)).status, 403);
ok('project count limit applies to create and zip import');

// ---- 项目大小上限（300 KB）
const big = new FormData();
big.append('file', new Blob([new Uint8Array(400_000)]), 'big.png');
const up = await alice.req('POST', `/api/projects/${p1.id}/upload`, big);
assert.equal(up.status, 413, JSON.stringify(up.data));
const small = new FormData();
small.append('file', new Blob([new Uint8Array(100_000)]), 'small.png');
assert.equal((await alice.req('POST', `/api/projects/${p1.id}/upload`, small)).status, 200);
ok('project size limit rejects uploads that would exceed it');

// ---- 编译排队（COMPILE_CONCURRENCY=1）：同时编译两个项目，后到的那个收到排队事件（先后顺序不固定，两个都监听）
const events = { [p1.id]: [], [p2.id]: [] };
const ctrl = new AbortController();
const listen = (pid) =>
  fetch(`${BASE}/api/projects/${pid}/events`, { headers: { cookie: alice.cookie }, signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) events[pid].push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      /* aborted */
    }
  });
const streams = [listen(p1.id), listen(p2.id)];
await new Promise((r) => setTimeout(r, 300));
const [c1, c2] = await Promise.all([alice.req('POST', `/api/projects/${p1.id}/compile`), alice.req('POST', `/api/projects/${p2.id}/compile`)]);
assert.equal(c1.status, 200);
assert.equal(c2.status, 200);
await new Promise((r) => setTimeout(r, 300));
ctrl.abort();
await Promise.all(streams);
const queued = [p1.id, p2.id].map((pid) => events[pid].filter((e) => e.type === 'compile_queued').map((e) => e.position));
assert.deepEqual(queued.sort((x, y) => x.length - y.length), [[], [1, 0]], `queue events: ${JSON.stringify(events)}`);
ok('compiles beyond the concurrency limit queue and report their position');

// ---- 每人每分钟最多 3 次编译（上面已用 2 次）
assert.equal((await alice.req('POST', `/api/projects/${p1.id}/compile`)).status, 200);
const limited = await alice.req('POST', `/api/projects/${p1.id}/compile`);
assert.equal(limited.status, 429, JSON.stringify(limited.data));
assert.equal((await b.s.req('POST', '/api/projects', { name: 'bob p' })).status, 200);
ok('compiles are rate-limited per user');

// ---- 管理员：服务器 CLI Agent、本机 Agent 一键配置、自定义模型地址都被关闭
const admin = session();
assert.equal((await admin.req('POST', '/api/auth/login', { email: 'a@test.dev', password: 'password123' })).status, 200);
assert.deepEqual((await admin.req('GET', '/api/agent/backends')).data.backends, ['builtin']);
assert.equal((await admin.req('GET', '/api/agent-setup/local')).data.enabled, false);
const custom = await admin.req('PUT', '/api/ai/settings', { preset: 'custom', provider: 'openai', baseUrl: 'https://example.com/v1', model: 'x', apiKey: 'k' });
assert.equal(custom.status, 403, JSON.stringify(custom.data));
assert.equal((await admin.req('GET', '/api/ai/settings')).data.customBaseUrlAllowed, false);
ok('server-side CLI agents, local agent setup and custom endpoints are disabled even for admins');

// ---- 协作者：添加后能访问，移除后立即无权访问；所有者不能被移除
const bobId = (await b.s.req('GET', '/api/auth/me')).data.id;
assert.equal((await alice.req('POST', `/api/projects/${p1.id}/members`, { email: `bob-${run}@demo.test`, role: 'viewer' })).status, 200);
assert.equal((await b.s.req('GET', `/api/projects/${p1.id}/files`)).status, 200);
const members = (await alice.req('GET', `/api/projects/${p1.id}/members`)).data;
assert.deepEqual(members.map((m) => m.role).sort(), ['owner', 'viewer']);
assert.equal((await b.s.req('DELETE', `/api/projects/${p1.id}/members/${bobId}`)).status, 403);
assert.equal((await alice.req('DELETE', `/api/projects/${p1.id}/members/${bobId}`)).status, 200);
assert.equal((await b.s.req('GET', `/api/projects/${p1.id}/files`)).status, 404); // 非成员看不到项目（与不存在一样返回 404）
const aliceId = members.find((m) => m.role === 'owner').userId;
assert.equal((await alice.req('DELETE', `/api/projects/${p1.id}/members/${aliceId}`)).status, 404);
ok('collaborators can be removed by the owner and lose access immediately');

// 清理：删除本次的项目
for (const p of [p1, p2]) await alice.req('DELETE', `/api/projects/${p.id}`);
console.log('ALL PUBLIC DEMO TESTS PASSED');
