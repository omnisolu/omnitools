#!/usr/bin/env bash
#
# OmniTools — Debian 安装与部署脚本
# 用法（需 root）: sudo bash install.sh
# 可选 SSL: DOMAIN=example.com EMAIL=you@example.com sudo bash install.sh
# 请在包含 package.json 的项目根目录下执行（与 install.sh 同级）。
#
set -euo pipefail

APP_NAME="OmniTools"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SITE="omnitools"
NGINX_CONF="/etc/nginx/sites-available/${NGINX_SITE}"
SSL_DOMAIN="${DOMAIN:-}"
CERTBOT_EMAIL="${EMAIL:-}"

log() { printf '[OmniTools] %s\n' "$*"; }
die() { log "错误: $*"; exit 1; }

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "请使用 root 运行: sudo bash install.sh"
fi

if [[ ! -f /etc/debian_version ]]; then
  die "本脚本以 Debian / Ubuntu 系发行版为基准，未检测到 /etc/debian_version"
fi

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  die "未找到 ${APP_DIR}/package.json，请将 install.sh 放在项目根目录"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# --- Node.js（优先 NodeSource 20.x；已存在且版本足够则跳过） ---
need_node_install=true
if command -v node >/dev/null 2>&1; then
  major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "${major}" -ge 18 ]]; then
    need_node_install=false
  fi
fi

if [[ "${need_node_install}" == true ]]; then
  log "安装 Node.js 20.x（NodeSource）…"
  apt-get install -y -qq ca-certificates curl gnupg
  install -d -m0755 /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/nodesource.gpg ]]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  fi
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi

command -v node >/dev/null 2>&1 || die "未找到 node"
command -v npm >/dev/null 2>&1 || die "未找到 npm"
log "Node $(node -v) / npm $(npm -v)"

# --- nginx ---
apt-get install -y -qq nginx

# --- 构建前端 ---
log "安装 npm 依赖并构建 ${APP_NAME}…"
cd "${APP_DIR}"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

[[ -f "${APP_DIR}/dist/index.html" ]] || die "构建失败：未生成 dist/index.html"

# --- Email 服务（systemd 服务）---
log "配置邮件服务 systemd…"
cat > "/etc/systemd/system/omnitools-email.service" <<'SVCEOF'
[Unit]
Description=OmniTools Email Server
After=network.target
StartLimitInterval=200
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server/send-mail.mjs
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF
# 替换 ${APP_DIR} 占位符
sed -i "s|\${APP_DIR}|${APP_DIR}|g" /etc/systemd/system/omnitools-email.service

systemctl daemon-reload
systemctl enable omnitools-email
systemctl restart omnitools-email

# --- nginx 站点（SPA + API 代理）---
log "配置 nginx 站点 ${NGINX_SITE}…"
cat > "${NGINX_CONF}" <<EOF
# ${APP_NAME} — 由 install.sh 生成
upstream email_server {
    server 127.0.0.1:3001;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${SSL_DOMAIN:-_};

    root ${APP_DIR}/dist;
    index index.html;

    add_header X-Content-Type-Options nosniff always;

    # API 代理
    location /api/ {
        proxy_pass http://email_server;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 100M;
    }

    # SPA 路由
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # 静态资源缓存
    location ~* \\.(?:js|css|png|jpg|jpeg|gif|ico|svg|webp|woff2?)\$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
}
EOF

ln -sf "${NGINX_CONF}" "/etc/nginx/sites-enabled/${NGINX_SITE}"

if [[ -L /etc/nginx/sites-enabled/default ]]; then
  log "禁用默认站点 default（保留文件于 sites-available）…"
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable nginx
systemctl reload nginx

if [[ -n "${SSL_DOMAIN}" ]]; then
  log "安装 certbot 并为 ${SSL_DOMAIN} 启用 HTTPS…"
  apt-get install -y -qq certbot python3-certbot-nginx

  certbot_args=(--nginx --redirect --agree-tos --non-interactive -d "${SSL_DOMAIN}")
  if [[ -n "${CERTBOT_EMAIL}" ]]; then
    certbot_args+=(--email "${CERTBOT_EMAIL}")
  else
    certbot_args+=(--register-unsafely-without-email)
  fi

  certbot "${certbot_args[@]}"
  systemctl reload nginx
fi

app_host="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"
if [[ -n "${SSL_DOMAIN}" ]]; then
  app_url="https://${SSL_DOMAIN}/"
else
  app_url="http://${app_host}/"
fi

log "完成。"
log "  应用目录: ${APP_DIR}"
log "  静态文件:  ${APP_DIR}/dist"
log "  访问地址:  ${app_url}"
log "更新部署:   cd ${APP_DIR} && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl reload nginx"
