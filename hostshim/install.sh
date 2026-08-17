#!/usr/bin/env bash
# install.sh — поставить claude-shim службой на хост (там, где авторизован CLI).
#
# Шим нужен потому, что human4ai работает в контейнере, а `claude` CLI живёт и
# авторизован на хосте: вместо переноса авторизации внутрь образа контейнер
# просит хост выполнить один вызов.
#
#   bash hostshim/install.sh                 # токен сгенерируется сам
#   SHIM_TOKEN=<секрет> bash hostshim/install.sh
#
# Печатает строки, которые нужно положить в секреты репозитория:
# CLAUDE_SHIM_URL и CLAUDE_SHIM_TOKEN.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="/opt/claude-shim"
PORT="${SHIM_PORT:-4021}"
TOKEN="${SHIM_TOKEN:-$(openssl rand -hex 24)}"
NODE="$(command -v node)"

[ -n "$NODE" ] || { echo "нужен node на хосте"; exit 1; }
command -v claude >/dev/null || { echo "нужен авторизованный claude CLI на хосте"; exit 1; }

install -d "$TARGET"
install -m 0755 "$SRC/claude-shim.mjs" "$TARGET/claude-shim.mjs"

# Токен и порт — в отдельном файле, чтобы не светиться в списке процессов.
umask 077
cat > "$TARGET/env" <<EOF
SHIM_TOKEN=$TOKEN
SHIM_PORT=$PORT
CLAUDE_BIN=$(command -v claude)
# Служба идёт от root, а в /root/.claude/settings.json стоит bypassPermissions —
# без этого признака CLI отказывается стартовать («--dangerously-skip-permissions
# cannot be used with root/sudo privileges»). Вызов здесь и так неинтерактивный и
# ограничен инструментом Read во временном каталоге.
IS_SANDBOX=1
EOF

cat > /etc/systemd/system/claude-shim.service <<EOF
[Unit]
Description=claude-shim — вызов claude CLI с хоста для контейнера human4ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$TARGET/env
ExecStart=$NODE $TARGET/claude-shim.mjs
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet claude-shim
systemctl restart claude-shim
sleep 2

echo "==> статус: $(systemctl is-active claude-shim)"
echo "==> health: $(curl -s -m5 "http://127.0.0.1:$PORT/health" || echo 'нет ответа')"

# Контейнер ходит с docker-моста, а на хосте INPUT по умолчанию DROP.
if command -v /usr/local/hestia/bin/v-add-firewall-rule >/dev/null; then
  if ! iptables -S INPUT | grep -q -- "--dport $PORT"; then
    /usr/local/hestia/bin/v-add-firewall-rule ACCEPT 172.16.0.0/12 "$PORT" TCP 'claude-shim for docker'
    /usr/local/hestia/bin/v-update-firewall
    echo "==> открыт порт $PORT для docker-подсетей"
  fi
fi

echo
echo "Положи в секреты репозитория:"
echo "  CLAUDE_SHIM_URL=http://host.docker.internal:$PORT"
echo "  CLAUDE_SHIM_TOKEN=$TOKEN"
