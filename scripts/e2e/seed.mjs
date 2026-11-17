// 为端到端测试准备数据：账号 a@test.dev / password123，以及名为 Demo、内容已知的项目。
// 用法：node scripts/e2e/seed.mjs（需先启动服务端；可重复执行，会把 Demo/main.tex 重置为初始内容）
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const EMAIL = 'a@test.dev';
const PASSWORD = 'password123';

const DEMO_MAIN = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Server Side Title}
\author{Author Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Write your abstract here.
\end{abstract}

\section{Introduction}
Intro

\end{document}
`;

const json = { 'content-type': 'application/json' };
let res = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: json, body: JSON.stringify({ email: EMAIL, name: 'Test User', password: PASSWORD }) });
if (res.status === 409) res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
const cookie = res.headers.get('set-cookie').split(';')[0];
const api = async (p, init = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...init, headers: { ...json, cookie, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${p}: ${r.status} ${await r.text()}`);
  return r.json();
};

let demo = (await api('/api/projects')).find((p) => p.name === 'Demo');
if (!demo) demo = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Demo' }) });

// 用一个临时 MCP 令牌重置 main.tex（走正常的 Yjs 写入路径）
const tok = await api('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'seed', projectId: demo.id }) });
try {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...json, accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'main.tex', content: DEMO_MAIN } } }),
  });
  const out = (await r.json()).result;
  if (out.isError) throw new Error(out.content[0].text);
} finally {
  await api(`/api/tokens/${tok.summary.id}`, { method: 'DELETE' });
}
console.log(`seeded ${EMAIL} with project Demo (${demo.id})`);
