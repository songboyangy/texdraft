# Deploying with Docker

```bash
cp deploy/.env.example deploy/.env      # set POSTGRES_PASSWORD, PUBLIC_URL and the AI settings
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f app
```

Open `http://127.0.0.1:8787` (or your `PUBLIC_URL`) and register. The first account becomes the administrator; with the default `REGISTRATION=invite`, everyone else needs an invite link from the Admin page.

- **Data**: PostgreSQL lives in the `pgdata` volume, files and compile output in the `data` volume. Back up with
  `docker compose -f deploy/docker-compose.yml exec db pg_dump -U texdraft texdraft > backup.sql`
  plus the `blobs/` directory of the `data` volume.
- **HTTPS**: the port is bound to `127.0.0.1` by default. Put Nginx, Caddy or a Cloudflare Tunnel in front and set `PUBLIC_URL` to that address. The proxy must forward WebSockets (`/collab`) and must not buffer server-sent events (Nginx: `proxy_buffering off`).
- **Compile isolation**: the image compiles with TeX Live (latexmk). Compiles run as the unprivileged user `texcompile` (`COMPILE_SANDBOX=uid`), which cannot read the server's environment or data directories; latexmk ignores project `latexmkrc` files, shell-escape is disabled and kpathsea's paranoid mode blocks paths outside the project. The container keeps only the capabilities needed for this (see `docker-compose.yml`).
- **TeX Live packages**: common packages plus Chinese / CJK support are installed (about 2 GB). For the full distribution:
  `docker compose -f deploy/docker-compose.yml build --build-arg TEXLIVE_PACKAGES="latexmk biber texlive-full"`
- **Public demo**: for a server open to strangers set `PUBLIC_DEMO=true`, `SOURCE_URL` (AGPL requires offering the source to network users) and, ideally, Turnstile keys. This turns on per-user quotas, per-IP sign-up limits and per-user compile rate limits, and disables server-side CLI agents and custom model endpoints. Combine it with `AI_SHARED_CREDIT` so each account gets a small free AI credit. See `deploy/.env.example`.
- **Upgrading**: `git pull && docker compose -f deploy/docker-compose.yml up -d --build`. Database migrations run automatically at start.

中文说明见 [README.zh-CN.md](../README.zh-CN.md#快速开始docker)。
