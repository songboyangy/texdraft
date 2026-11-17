# Self-hosting TeXdraft

## Docker (recommended)

```bash
git clone https://github.com/songboyangy/texdraft.git && cd texdraft
cp deploy/.env.example deploy/.env      # set POSTGRES_PASSWORD, PUBLIC_URL and your AI key
docker compose -f deploy/docker-compose.yml up -d --build
```

Open http://127.0.0.1:8787 and register. The first account becomes the administrator.

The image includes TeX Live with common packages and Chinese support (about 2 GB). For HTTPS, backups, upgrades and a full TeX Live build, see [deploy/README.md](../deploy/README.md).

## Without Docker

`scripts/prod.sh` runs PostgreSQL and the server, which also serves the built web app. It can also start a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). It needs no root, and the tunnel lets it work on a machine without a public IP:

```bash
cp .env.example .env && cp .env.production.example .env.production   # .env.production overrides .env
pnpm install && pnpm prod build
pnpm prod start          # also: stop | restart | status | logs [server|tunnel] | ensure
```

To use the tunnel, set `CLOUDFLARE_TUNNEL_TOKEN` (or `CLOUDFLARE_TUNNEL_TOKEN_FILE`) so that `cloudflared` starts with it, and point the tunnel's public hostname at `http://127.0.0.1:8787`. Where UDP to Cloudflare is lossy (mainland China, for example), `CLOUDFLARED_PROTOCOL=http2` makes uploads much faster.

For compiling, install [TeX Live](https://tug.org/texlive/) (no root needed: it can live in your home directory), put its `bin/<arch>` directory on `PATH` in `.env.production` and set `COMPILE_RUNNER=local-latexmk`. Without root this setup usually cannot isolate compiles (see [Security model](#security-model)), so only give accounts to people you trust.

## Configuration

All settings are environment variables (see [.env.example](../.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://texdraft@127.0.0.1:5433/texdraft` | PostgreSQL connection |
| `SESSION_SECRET` | generated | Signs session cookies. If empty, a random secret is generated on first start and saved to `DATA_DIR/session-secret` (back it up with your data). Placeholder values are refused |
| `PUBLIC_URL` | `http://127.0.0.1:8787` | External URL; also the OAuth issuer for ChatGPT / Claude.ai |
| `REDIRECT_HOSTS` | (empty) | Old hostnames, comma-separated, permanently redirected to `PUBLIC_URL` after moving to a new domain |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address |
| `SERVE_WEB` | — | `1` serves the built web app from the API server |
| `DATA_DIR` | `./data` | Uploaded files, compile workspaces |
| `REGISTRATION` | `open` | Initial registration mode: `open`, `invite`, `closed` (admins can change it later) |
| `ADMIN_EMAILS` | — | Comma-separated emails that become admins |
| `COMPILE_RUNNER` | `local-tectonic` | `local-latexmk` (TeX Live on the host), `local-tectonic` or `docker`. Tectonic downloads packages on demand but only has the XeTeX engine, so pdfLaTeX-only templates (e.g. AAAI) do not compile with it |
| `COMPILE_SANDBOX` | `auto` | `auto`, `bwrap`, `uid`, `none`; see [Security model](#security-model) |
| `COMPILE_TIMEOUT_MS` | `90000` | Per-compile time limit |
| `AGENT_PROVIDER` | `anthropic` | Which protocol the built-in agent uses; see [AGENT_PROVIDER values](#agent_provider-values) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | Credentials and endpoint for the chosen provider (`AGENT_API_KEY` / `AGENT_BASE_URL` override both) |
| `AGENT_VISION` | `auto` | Whether the model can view rendered PDF pages |
| `AGENT_CONTEXT_WINDOW` | `200000` or `128000` | The model's context size |
| `AGENT_COMPACT_AT` | `0.75` | Share of the context window at which long conversations are compacted |
| `AGENT_MODEL` / `AGENT_MAX_TOKENS` / `AGENT_EFFORT` / `AGENT_MAX_STEPS` | `claude-opus-5-5` / `64000` / `high` / `40` | Agent model and limits |
| `AGENT_BETA_FEATURES` | `true` | Set `false` for gateways that reject beta parameters |
| `AI_SHARED_KEY` | `all` | Who may use the server's AI key: `all`, `admins` or `none` |
| `AI_SHARED_DAILY_TOKENS` | `0` | Per-user daily token allowance on the server's key (0 = unlimited) |
| `AI_SHARED_CREDIT` | `0` | Total credit per user on the server's key, in `AI_CURRENCY` (e.g. `1`; 0 = unlimited). Admins can change it per user in the admin panel; admins themselves are not limited |
| `AI_PRICE_INPUT` / `AI_PRICE_CACHED` / `AI_PRICE_OUTPUT` | `2` / `0.04` / `8` | Server-model prices per million tokens (uncached input / cached input / output), used to charge the credit. The defaults are DeepSeek Flash peak rates |
| `AI_CURRENCY` | `¥` | Currency symbol for the credit |
| `AI_CUSTOM_BASE_URL` | `admins` | Who may enter a custom model endpoint: `admins`, `all` (public https only) or `none` |
| `AI_KEYS_SECRET` | `SESSION_SECRET` | Secret for encrypting stored keys |
| `TEXDRAFT_PLUGINS` | — | Server plugins to load; see [plugins.md](plugins.md) |
| `PUBLIC_DEMO` | `false` | Hosted demo mode: turns on the abuse-limit defaults below and disables server-side CLI agents and custom model endpoints |
| `SOURCE_URL` | — | Source-code link in the UI (AGPL) |
| `DEMO_NOTICE` | `default` in demo mode | Floating demo notice; `off` hides it |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | — | Cloudflare Turnstile check on sign-up |
| `MAX_PROJECTS_PER_USER` / `MAX_PROJECT_BYTES` / `REGISTRATIONS_PER_IP_PER_DAY` / `COMPILES_PER_MINUTE` | `0` (demo: `20` / `100 MB` / `3` / `10`) | Abuse limits (0 = unlimited; admins are exempt from per-user limits) |
| `COMPILE_CONCURRENCY` | CPU cores | Concurrent compiles; extra requests queue and the editor shows their position |
| `OAUTH_CIMD_HOSTS` | `chatgpt.com,claude.ai` | Hosts allowed to serve OAuth client metadata documents. Set it empty when your server cannot reach them (data-centre IPs often get HTTP 403 from a bot check); clients then use dynamic registration |
| `ALLOW_LOCAL_AGENT_SETUP` | `false` | Single-user servers only: let the web UI configure and run the server's Claude Code / Codex / Gemini CLI |

### `AGENT_PROVIDER` values

| Value | Use for |
|---|---|
| `anthropic` | The Claude API. Supports adaptive thinking, prompt caching and beta features |
| `compatible` | Anthropic-compatible endpoints, e.g. DeepSeek |
| `openai` | OpenAI Chat Completions-compatible endpoints: OpenAI, Gemini, Qwen, Kimi, GLM, OpenRouter, Ollama … |

### Example: DeepSeek instead of Claude

```ini
AGENT_PROVIDER=compatible
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_API_KEY=sk-...
AGENT_MODEL=deepseek-chat
AGENT_MAX_TOKENS=8192
```

Users can also bring their own key in *Account settings → AI model*.

## Security model

LaTeX documents are untrusted input. `\input{/etc/...}` can read any file the compiler can read, and a project's `latexmkrc` could run code.

TeXdraft always:

- passes only an allowlisted environment to the compiler (no API keys, session secret or database URL)
- disables shell-escape
- runs latexmk with `-norc`
- enables kpathsea's paranoid mode for TeX Live

On top of that, `COMPILE_SANDBOX` isolates each compile:

| Mode | What it does |
|---|---|
| `bwrap` | A bubblewrap filesystem view that contains only the toolchain, package caches and the current project (source read-only, output writable). Needs unprivileged user namespaces; on Ubuntu 24.04 set `kernel.apparmor_restrict_unprivileged_userns=0`. Not available inside containers with the default seccomp profile. |
| `uid` | Used by the Docker image. The server runs as root inside the container, and compiles run as an unprivileged user that cannot read the server's environment or data directories. |
| `auto` | Picks `bwrap`, then `uid`. If neither is available, it logs a warning and runs without isolation, which is acceptable only for single-user setups. |

Alternatively, `COMPILE_RUNNER=docker` runs each compile in its own container.

`scripts/e2e/compile-sandbox.mjs` checks that the server's secrets and other files are invisible to documents. Please report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).
