#!/usr/bin/env bash
#
# OmniTools — 服务器上更新部署（与 install.sh 配套）
# 用法（需 root）: sudo bash upgrade.sh
# 请在项目根目录执行（与 package.json 同级）。
#
# 会执行：git pull → 确保编译依赖与 data/upload 目录 → npm ci（失败则 npm install）→ build →
#       重启 omnitools-email → reload nginx
# 若需改邮件 API 端口（与 3001 冲突），请用 install.sh 的 EMAIL_API_PORT 或手动改 systemd Environment=PORT 与 Nginx upstream。
#
set -euo pipefail

APP_NAME="OmniTools"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[OmniTools upgrade] %s\n' "$*"; }
die() { log "错误: $*"; exit 1; }

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "请使用 root 运行: sudo bash upgrade.sh"
fi

if [[ ! -f "${SCRIPT_DIR}/package.json" ]]; then
  die "未找到 ${SCRIPT_DIR}/package.json，请在项目根目录执行"
fi

cd "${SCRIPT_DIR}"

log "工作目录: ${SCRIPT_DIR}"
echo ""

log "拉取最新代码…"
git pull || die "git pull 失败"

# better-sqlite3 等原生模块需要本机编译
if [[ -f /etc/debian_version ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq build-essential
fi

log "确保 data/、upload/ 目录存在…"
install -d -m0755 "${SCRIPT_DIR}/data" "${SCRIPT_DIR}/upload"

log "安装 npm 依赖…"
if [[ -f package-lock.json ]]; then
  if ! npm ci; then
    log "npm ci 失败（package-lock.json 与 package.json 不同步），改用 npm install…"
    npm install
  fi
else
  npm install
fi

log "编译 better-sqlite3 原生模块…"
npm rebuild better-sqlite3 || die "better-sqlite3 编译失败。请确认已安装 build-essential。"

log "构建前端…"
npm run build

[[ -f "${SCRIPT_DIR}/dist/index.html" ]] || die "构建失败：未生成 dist/index.html"

log "重启邮件/API 服务 omnitools-email…"
if systemctl is-enabled omnitools-email >/dev/null 2>&1; then
  systemctl restart omnitools-email
  log "omnitools-email 已重启"
else
  log "未检测到 omnitools-email（若尚未运行过 install.sh，请先执行安装脚本）"
fi

log "重载 Nginx…"
if systemctl is-active nginx >/dev/null 2>&1; then
  nginx -t
  systemctl reload nginx
else
  log "Nginx 未运行或未安装，已跳过 reload"
fi

echo ""
log "完成。"
log "  SQLite: ${SCRIPT_DIR}/data/omnitools.sqlite"
log "  上传:   ${SCRIPT_DIR}/upload/"
