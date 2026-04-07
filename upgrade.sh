#!/usr/bin/env bash
#
# OmniTools — 服务器上更新部署（与 install.sh 配套）
# 用法（需 root）: sudo bash upgrade.sh
# 请在项目根目录执行（与 package.json 同级）。
#
# 会执行：git pull → 确保编译依赖与 data/upload 目录 → npm ci（失败则 npm install）→ build →
#       检查并重启 omnitools-email（显式 stop → 等待端口释放 → start → /api/health）→ reload nginx
# 若需改邮件 API 端口（与 3001 冲突），请用 install.sh 的 EMAIL_API_PORT 或手动改 systemd Environment=PORT 与 Nginx upstream。
#
# 可选环境变量（与 sudo 一起 export 后执行）：
#   OMNITOOLS_UPGRADE_FORCE_FREE_PORT=1 — 若 stop 后端口仍被占用，对监听该 TCP 端口的进程执行 fuser -k（慎用）
#
set -euo pipefail

APP_NAME="OmniTools"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[OmniTools upgrade] %s\n' "$*"; }
die() { log "错误: $*"; exit 1; }

# --- omnitools-email：解析端口、检查监听、健康检查（减轻 EADDRINUSE / 僵尸占用）---

get_email_api_port() {
  local p=""
  if systemctl cat omnitools-email.service >/dev/null 2>&1; then
    p="$(systemctl show omnitools-email -p Environment --value 2>/dev/null | tr ' ' '\n' | grep '^PORT=' | head -1 | cut -d= -f2)"
  fi
  if [[ -n "${p:-}" && "${p}" =~ ^[0-9]+$ ]]; then
    echo "${p}"
    return 0
  fi
  local unit="/etc/systemd/system/omnitools-email.service"
  if [[ -f "${unit}" ]]; then
    p="$(grep -E '^Environment=PORT=' "${unit}" 2>/dev/null | head -1 | sed 's/^Environment=PORT=//;s/[[:space:]].*//')"
  fi
  if [[ -n "${p:-}" && "${p}" =~ ^[0-9]+$ ]]; then
    echo "${p}"
  else
    echo "3001"
  fi
}

tcp_port_listening() {
  local port="$1"
  command -v ss >/dev/null 2>&1 || return 1
  ss -tln 2>/dev/null | grep -qE ":${port}([[:space:]]|$)"
}

wait_for_tcp_port_free() {
  local port="$1"
  local max_wait="${2:-25}"
  local i
  for ((i = 0; i < max_wait; i++)); do
    if ! tcp_port_listening "${port}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

api_health_ok() {
  local port="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -sf --max-time 3 "http://127.0.0.1:${port}/api/health" >/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null --timeout=3 "http://127.0.0.1:${port}/api/health" 2>/dev/null
  else
    timeout 3 bash -c "echo >/dev/tcp/127.0.0.1/${port}" 2>/dev/null
  fi
}

wait_for_api_health() {
  local port="$1"
  local max_tries="${2:-40}"
  local i
  for ((i = 0; i < max_tries; i++)); do
    if api_health_ok "${port}"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_omnitools_email_safe() {
  local unit_file="/etc/systemd/system/omnitools-email.service"
  if [[ ! -f "${unit_file}" ]] && ! systemctl cat omnitools-email.service >/dev/null 2>&1; then
    log "未检测到 omnitools-email 单元（若尚未运行过 install.sh，请先执行安装脚本）"
    return 0
  fi

  systemctl daemon-reload

  local email_port
  email_port="$(get_email_api_port)"
  log "API 监听端口（systemd / 默认）: ${email_port}"

  log "更新前：systemctl status omnitools-email"
  systemctl status omnitools-email --no-pager -l || true

  log "停止 omnitools-email…"
  systemctl stop omnitools-email || true
  sleep 1

  if tcp_port_listening "${email_port}"; then
    log "端口 ${email_port} 仍在监听，等待释放（最多约 25s）…"
    if ! wait_for_tcp_port_free "${email_port}" 25; then
      log "警告：端口 ${email_port} 在停止后仍被占用。当前监听情况："
      ss -tlnp 2>/dev/null | grep -E ":${email_port}([[:space:]]|$)" || ss -tlnp 2>/dev/null || true
      if [[ "${OMNITOOLS_UPGRADE_FORCE_FREE_PORT:-0}" == "1" ]]; then
        log "OMNITOOLS_UPGRADE_FORCE_FREE_PORT=1：执行 fuser -k ${email_port}/tcp …"
        if command -v fuser >/dev/null 2>&1; then
          fuser -k -TERM "${email_port}/tcp" 2>/dev/null || true
          sleep 2
        else
          log "未安装 fuser（通常来自 psmisc），请 apt install psmisc 或手动结束占用进程。"
        fi
        if ! wait_for_tcp_port_free "${email_port}" 10; then
          journalctl -u omnitools-email -n 30 --no-pager || true
          die "端口 ${email_port} 仍无法释放，请检查是否有非 systemd 启动的 node 占用。"
        fi
      else
        log "提示：可排查占用进程后重试；或 OMNITOOLS_UPGRADE_FORCE_FREE_PORT=1 sudo -E bash upgrade.sh 尝试结束占用（慎用）。"
        journalctl -u omnitools-email -n 25 --no-pager || true
        die "无法释放端口 ${email_port}，omnitools-email 未启动。"
      fi
    fi
  fi

  log "启动 omnitools-email…"
  systemctl start omnitools-email
  sleep 1

  if ! systemctl is-active --quiet omnitools-email; then
    log "服务未处于 active，最近日志："
    journalctl -u omnitools-email -n 60 --no-pager || true
    die "omnitools-email 启动失败（systemctl is-active 非 active）"
  fi

  log "检查 http://127.0.0.1:${email_port}/api/health …"
  if ! wait_for_api_health "${email_port}" 45; then
    log "健康检查超时，最近日志："
    journalctl -u omnitools-email -n 60 --no-pager || true
    die "健康检查失败（请确认无端口冲突且 send-mail.mjs 正常）。"
  fi

  log "omnitools-email 已就绪（${email_port}/api/health）"
  systemctl status omnitools-email --no-pager -l || true
}

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

log "检查并重启邮件/API 服务 omnitools-email（避免端口占用导致启动失败）…"
restart_omnitools_email_safe

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
