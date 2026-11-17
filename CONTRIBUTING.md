# Contributing to TeXdraft

Thanks for your interest! Bug reports, fixes, features and documentation are all welcome. 欢迎用中文或英文提交 issue 和 PR。

## Getting started

Follow the [development guide](docs/development.md). In short: Node.js ≥ 22, pnpm 9, PostgreSQL 16 and tectonic or TeX Live, then

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

## Project layout

```
apps/server/src
  agent/        built-in AI agent: tool loop, tools, checkpoints, CLI (Claude Code / Codex) backends
  ai/           per-user model settings, provider presets, quota provider (ai/quota.ts)
  plugins.ts    server plugin loader (TEXDRAFT_PLUGINS, see docs/plugins.md)
  mcp/          MCP server and its extra tools (project management, paper review)
  oauth/        OAuth 2.1 authorization server for remote MCP clients
  accounts/     registration modes, invites, admin operations
  compile/      LaTeX runners, sandbox, log parser, SyncTeX
  collab/       Hocuspocus (Yjs) server and transactional text edits
  projects/     projects, files, versions, citations, search
  routes/       HTTP routes
  db/           Drizzle schema and migrations (apps/server/drizzle)
apps/web/src
  pages/, components/, lib/
  lib/overleaf/ LaTeX language support taken from Overleaf (keep its layout; see NOTICE)
packages/shared types shared by server and web
scripts/e2e     end-to-end tests
deploy/         Docker Compose deployment
```

## Making changes

- **Database**: edit `apps/server/src/db/schema.ts`, then `pnpm db:generate` and commit the generated SQL and snapshot. Migrations run automatically at server start.
- **UI text**: every string lives in `apps/web/src/lib/locales.ts` with both `zh-CN` and `en` entries (TypeScript enforces that the English table is complete).
- **Text edits on the server** must go through `transactText` (`collab/hocuspocus.ts`) with minimal replacements, never by writing the database directly, so that open editors and collaborators stay in sync.
- **Compiles**: anything that runs TeX must use `compile/runner.ts` so the sandbox and environment allowlist apply.
- **Comments**: much of the existing code is commented in Chinese. New comments in English or Chinese are both fine; explain *why*, not *what*.
- Keep pull requests focused; unrelated refactors are easier to review separately.

## Tests

Before opening a pull request:

```bash
pnpm typecheck
pnpm test
```

If you touch the server, run the relevant end-to-end tests from `scripts/e2e` against a local server (see [Testing](docs/development.md#testing)); `node scripts/e2e/seed.mjs` creates the account and project they expect. Add or extend an end-to-end test for new behaviour. CI runs everything, including the Docker image.

## Commits and pull requests

- Write commit messages in the imperative mood ("Add …", "Fix …") with a short body explaining the motivation when it is not obvious.
- Describe what changed and how you tested it in the pull request.
- Security issues: do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Contributor License Agreement

TeXdraft is licensed under the [GNU AGPL-3.0](LICENSE). Before your first pull request can be merged, you need to sign the [Contributor License Agreement](CLA.md). The CLA bot asks you on the pull request, and you sign by posting one comment. You only do this once.

The CLA lets the maintainer also offer TeXdraft under other terms, for example a commercial licence for organisations that cannot use the AGPL. In return, the CLA commits that every version containing your contribution stays available as open source. You keep the copyright in your work.

贡献前需要签署[贡献者许可协议](CLA.md)：在 PR 下按机器人的提示回复一句话即可，只需一次。你保留版权，项目承诺包含你贡献的版本始终开源。
