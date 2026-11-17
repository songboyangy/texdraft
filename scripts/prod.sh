#!/usr/bin/env bash
# Run TeXdraft without Docker and without root: PostgreSQL (scripts/dev-services.sh), the server
# (serving the built web app) and, optionally, a Cloudflare Tunnel. Use this on a machine where you
# cannot run Docker; otherwise prefer deploy/docker-compose.yml, which also isolates compiles.
#
#   bash scripts/prod.sh start|stop|restart|status|logs [server|tunnel]|build|ensure
#   ensure: start only what is not running, quietly (e.g. from a login shell or cron @reboot)
#
# Configuration: .env, then .env.production (see .env.production.example). Logs and pid files
# live in .devdata/logs and .devdata/run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.devdata/run"; LOGS="$ROOT/.devdata/logs"
mkdir -p "$RUN" "$LOGS"

[ -f "$ROOT/.env.production" ] || { echo "Missing .env.production (cp .env.production.example .env.production and fill it in)"; exit 1; }
set -a; [ -f "$ROOT/.env" ] && source "$ROOT/.env"; source "$ROOT/.env.production"; set +a
PORT="${PORT:-8787}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared || echo "$HOME/bin/cloudflared")}"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

build() {
  echo "Building the web app…"
  pnpm --dir "$ROOT" build
}

start_server() {
  if alive server; then echo "server already running (pid $(cat "$RUN/server.pid"))"; return; fi
  if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    echo "Port $PORT is in use (is the dev server, pnpm dev, still running? They share the database; do not run both)"; exit 1
  fi
  [ -f "$ROOT/apps/web/dist/index.html" ] || build
  bash "$ROOT/scripts/dev-services.sh" start
  cd "$ROOT/apps/server"
  # The variables are already exported in this shell (.env.production overrides .env)
  nohup "$ROOT/apps/server/node_modules/.bin/tsx" src/index.ts >>"$LOGS/server.log" 2>&1 &
  echo $! >"$RUN/server.pid"
  for _ in $(seq 1 60); do
    if curl -sf --noproxy '*' "http://127.0.0.1:$PORT/api/health" >/dev/null; then echo "server started: http://127.0.0.1:$PORT"; return; fi
    alive server || { echo "server failed to start, see $LOGS/server.log"; tail -20 "$LOGS/server.log"; exit 1; }
    sleep 1
  done
  echo "server not ready after 60 seconds, see $LOGS/server.log"
}

start_tunnel() {
  local auth=()
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN_FILE:-}" ]; then
    [ -r "$CLOUDFLARE_TUNNEL_TOKEN_FILE" ] || { echo "Cannot read the token file: $CLOUDFLARE_TUNNEL_TOKEN_FILE"; exit 1; }
    auth=(--token-file "$CLOUDFLARE_TUNNEL_TOKEN_FILE")
  elif [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    auth=(--token "$CLOUDFLARE_TUNNEL_TOKEN")
  else
    echo "CLOUDFLARE_TUNNEL_TOKEN(_FILE) not set, not starting a tunnel"; return
  fi
  if alive tunnel; then echo "tunnel already running (pid $(cat "$RUN/tunnel.pid"))"; return; fi
  [ -x "$CLOUDFLARED_BIN" ] || { echo "cloudflared not found: $CLOUDFLARED_BIN (install it or set CLOUDFLARED_BIN)"; exit 1; }
  # The tunnel connects to Cloudflare directly, not through an HTTP proxy
  env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u ALL_PROXY -u all_proxy \
    nohup "$CLOUDFLARED_BIN" tunnel --no-autoupdate --protocol "${CLOUDFLARED_PROTOCOL:-auto}" run "${auth[@]}" \
    >>"$LOGS/tunnel.log" 2>&1 &
  echo $! >"$RUN/tunnel.pid"
  echo "tunnel started → ${PUBLIC_URL:-}"
}

stop_one() {
  if alive "$1"; then kill "$(cat "$RUN/$1.pid")"; echo "$1 stopped"; else echo "$1 not running"; fi
  rm -f "$RUN/$1.pid"
}

status() {
  for s in server tunnel; do
    if alive $s; then echo "$s: running (pid $(cat "$RUN/$s.pid"))"; else echo "$s: not running"; fi
  done
}

case "${1:-}" in
  start) start_server; start_tunnel ;;
  stop) stop_one tunnel; stop_one server ;;
  restart) stop_one tunnel; stop_one server; sleep 2; start_server; start_tunnel ;;
  status) status ;;
  logs) tail -n 100 -f "$LOGS/${2:-server}.log" ;;
  build) build ;;
  ensure)
    { alive server || start_server; alive tunnel || start_tunnel; } >>"$LOGS/ensure.log" 2>&1 ;;
  *) echo "usage: $0 start|stop|restart|status|logs [server|tunnel]|build|ensure"; exit 1 ;;
esac
