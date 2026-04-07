#!/usr/bin/env bash
#
# OmniTools — Debian 安装与部署脚本
# 用法（需 root）: sudo bash install.sh
# 可选 SSL: DOMAIN=example.com EMAIL=you@example.com sudo bash install.sh
# 请在包含 package.json 的项目根目录下执行（与 install.sh 同级）。
#
# 数据说明（与当前代码一致）：
#   - data/omnitools.sqlite — better-sqlite3：报销数据 + SMTP（app_settings）
#   - upload/EXPYYMMXX/ — 合并 PDF 与收据附件
#   - 依赖 better-sqlite3 需在安装 npm 包时本机编译（需 build-essential）
# 可选环境变量（可写入 systemd drop-in 或 export 后重启 omnitools-email）：
#   SMTP_SECRET、OMNITOOLS_DB_PATH、OMNITOOLS_UPLOAD_DIR
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

# --- 原生模块编译（better-sqlite3）---
log "安装编译工具（用于 npm 构建 better-sqlite3）…"
apt-get install -y -qq build-essential

# --- 数据目录（SQLite 与上传附件；邮件服务运行用户需可写）---
log "创建 data/ 与 upload/…"
install -d -m0755 "${APP_DIR}/data" "${APP_DIR}/upload"

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
Description=OmniTools API (SMTP + SQLite + uploads)
After=network.target
StartLimitInterval=200
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
# 默认使用项目下 data/ 与 upload/；可取消注释并设置绝对路径
# Environment=OMNITOOLS_DB_PATH=/var/lib/omnitools/omnitools.sqlite
# Environment=OMNITOOLS_UPLOAD_DIR=/var/lib/omnitools/upload
# Environment=SMTP_SECRET=请替换为随机长字符串
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

    # 以下内容由 certbot 在启用 HTTPS 时自动更新
    # 请勿手动编辑此部分

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
  
  # 验证 API 代理配置在 SSL 配置中也存在
  log "验证 API 代理配置…"
  if ! grep -q "location /api/" "${NGINX_CONF}"; then
    log "⚠️  警告：API 代理配置在 SSL 修改后可能丢失，正在修复…"
    # 在第一个非 SSL 的 location 块前添加 API 代理
    sed -i '/location \/ {/i \    # API 代理\n    location \/api\/ {\n        proxy_pass http:\/\/email_server;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_buffering off;\n        proxy_request_buffering off;\n        client_max_body_size 100M;\n    }\n' "${NGINX_CONF}"
    nginx -t && systemctl reload nginx
  fi
  
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
log "  SQLite:    ${APP_DIR}/data/omnitools.sqlite（报销 + SMTP）"
log "  上传目录:  ${APP_DIR}/upload/（EXPYYMMXX 子目录）"
log "  访问地址:  ${app_url}"
log "  邮件 API:  systemctl status omnitools-email（端口 3001，经 Nginx /api/ 反代）"
log "后续更新:   sudo bash ${APP_DIR}/upgrade.sh"
