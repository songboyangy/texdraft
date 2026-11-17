# Development

## Setup

You need Node.js ≥ 22, pnpm 9, PostgreSQL 16, and either [tectonic](https://tectonic-typesetting.github.io/) or TeX Live with latexmk.

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL, SESSION_SECRET, ANTHROPIC_API_KEY …
pnpm db:migrate
pnpm dev                        # API on :8787, web on :5173 (use `pnpm dev:poll` if file watching fails)
```

Then:

- Open http://127.0.0.1:5173. `Ctrl/⌘ + S` compiles.
- If `initdb` and `pg_ctl` are on your `PATH`, `pnpm services:start` starts a throwaway local PostgreSQL on port 5433.

## Architecture

```
apps/web         React + Vite, CodeMirror 6 + y-codemirror, pdf.js
apps/server      Fastify (REST + SSE), Hocuspocus (/collab WebSocket), compile service, agent, MCP server, OAuth
packages/shared  Types shared by client and server
```

- **Documents**: each text file is one Y.Doc, persisted in PostgreSQL. Binary files are kept in a blob store (local disk by default).
- **Compiles**: snapshots are materialised incrementally by content hash, and intermediate files are kept for fast rebuilds. Compiles of one project are serialised and coalesced.
- **Agent** (`apps/server/src/agent`): a hand-written streaming tool loop.
  - Tools come from one registry shared with MCP (`apps/server/src/tools`).
  - Model providers (`agent/providers`) adapt the Anthropic and OpenAI protocols.
  - Conversations are stored append-only in Anthropic message format. What is sent to the model is a view on top of them (`agent/context.ts`). When the context fills up, the view clears old tool outputs and replaces early turns with a summary.
  - Agent edits go through Yjs transactions with minimal line diffs, so collaborators' concurrent edits are never overwritten.
- **Plugins**: modules listed in `TEXDRAFT_PLUGINS` can add routes and replace the AI quota policy without patching the server ([plugins.md](plugins.md)).
- **Scaling**: a single instance is assumed. Running multiple instances would need a shared event bus, a compile queue, the Hocuspocus Redis extension and S3-compatible blob storage.

## Testing

```bash
pnpm typecheck && pnpm test             # type checks and unit tests

# end-to-end, against a running server (the agent test uses a mock Anthropic API)
node scripts/e2e/mock-anthropic.mjs &
ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=test pnpm --filter @texdraft/server start &
node scripts/e2e/seed.mjs                # test account a@test.dev and a "Demo" project
node scripts/e2e/accounts.mjs            # registration modes, invites, admin, rate limiting
pnpm test:e2e                            # collaboration and agent
node scripts/e2e/mcp.mjs                 # MCP basics
CIMD=0 node scripts/e2e/oauth.mjs        # OAuth (CIMD=0 skips fetching ChatGPT's metadata)
URL_UPLOAD=0 node scripts/e2e/mcp-more.mjs
node scripts/e2e/mcp-paper.mjs           # compiles for real
node scripts/e2e/mcp-patch-concurrency.mjs
node scripts/e2e/compile-sandbox.mjs     # fails if compiles are not isolated
node scripts/e2e/agent-tools.mjs         # agent: registry tools, parallel reads, image results (mock API)
node scripts/e2e/agent-context.mjs       # agent: context compaction (server with AGENT_CONTEXT_WINDOW=24000)
node scripts/e2e/ai-settings.mjs         # per-user AI keys, test connection, usage
node scripts/e2e/plugins.mjs             # plugins (server with TEXDRAFT_PLUGINS=scripts/e2e/fixtures/quota-plugin.mjs)
```

CI (`.github/workflows/ci.yml`) runs all of these with the bubblewrap sandbox, and it also builds and tests the Docker image.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for conventions and how to open a pull request.
