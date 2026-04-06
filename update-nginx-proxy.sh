#!/bin/bash

# OmniTools Nginx Configuration Update
# This script adds API proxy to existing nginx configurations while preserving SSL/HTTPS

set -e

echo "=========================================="
echo "OmniTools Nginx Configuration Updater"
echo "=========================================="

# Check if script is run with sudo
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run with sudo"
   exit 1
fi

NGINX_CONF="${1:-}"

if [[ -z "$NGINX_CONF" ]]; then
  echo "Usage: sudo bash update-nginx-proxy.sh <nginx-config-path>"
  echo ""
  echo "Examples:"
  echo "  sudo bash update-nginx-proxy.sh /etc/nginx/sites-available/omnitools"
  echo "  sudo bash update-nginx-proxy.sh /etc/nginx/sites-enabled/default"
  echo ""
  echo "Common paths:"
  echo "  /etc/nginx/sites-available/omnitools"
  echo "  /etc/nginx/sites-available/default"
  echo "  /etc/nginx/conf.d/omnitools.conf"
  exit 1
fi

if [[ ! -f "$NGINX_CONF" ]]; then
  echo "❌ Config file not found: $NGINX_CONF"
  exit 1
fi

echo "📝 Config file: $NGINX_CONF"
echo ""

# Backup existing config
BACKUP_FILE="${NGINX_CONF}.backup.$(date +%s)"
cp "$NGINX_CONF" "$BACKUP_FILE"
echo "✅ Backed up existing config to: $BACKUP_FILE"
echo ""

# Check if upstream already exists
if grep -q "upstream email_server" "$NGINX_CONF"; then
  echo "ℹ️  Email server upstream already configured"
  # Check if API location exists
  if grep -q "location /api/" "$NGINX_CONF"; then
    echo "✅ API proxy location already exists, skipping..."
    exit 0
  fi
else
  echo "➕ Adding email server upstream..."
  # Add upstream block before first server block
  sed -i '1i upstream email_server {\n    server 127.0.0.1:3001;\n}\n' "$NGINX_CONF"
fi

# Add API proxy location block before "location /" block
echo "➕ Adding API proxy location..."

API_LOCATION='    # API proxy to email service
    location /api/ {
        proxy_pass http://email_server;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 100M;
    }\n'

# Use awk to insert API location before "location / {" or "location ~ {" or other locations
awk -v api="$API_LOCATION" '
  /^[[:space:]]*location / && !inserted {
    print api;
    inserted=1;
  }
  { print }
' "$NGINX_CONF" > "${NGINX_CONF}.tmp"
mv "${NGINX_CONF}.tmp" "$NGINX_CONF"

echo "✅ API proxy location added"
echo ""

# Test nginx config
echo "🧪 Testing nginx configuration..."
if nginx -t 2>&1 | grep -q "successful"; then
  echo "✅ Nginx configuration is valid"
else
  echo "❌ Nginx configuration has errors"
  echo "Restoring backup..."
  cp "$BACKUP_FILE" "$NGINX_CONF"
  nginx -t
  echo "⚠️  Restored backup"
  exit 1
fi
echo ""

# Reload nginx
echo "🔄 Reloading nginx..."
if systemctl reload nginx; then
  echo "✅ Nginx reloaded successfully"
else
  echo "❌ Failed to reload nginx"
  cp "$BACKUP_FILE" "$NGINX_CONF"
  systemctl reload nginx
  exit 1
fi
echo ""

echo "=========================================="
echo "✨ Nginx configuration updated!"
echo ""
echo "Updated config: $NGINX_CONF"
echo "Backup location: $BACKUP_FILE"
echo ""
echo "To verify HTTPS is working:"
echo "  curl -I https://<your-domain>/"
echo ""
echo "To test API endpoints:"
echo "  curl -I https://<your-domain>/api/test-smtp"
echo "=========================================="
