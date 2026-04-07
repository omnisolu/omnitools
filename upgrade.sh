#!/bin/bash

# OmniTools Upgrade Script
# This script pulls the latest code, installs dependencies, builds, and reloads Nginx

set -e

echo "=========================================="
echo "OmniTools Upgrade Script"
echo "=========================================="

# Check if script is run with sudo
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run with sudo"
   exit 1
fi

# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "📁 Working directory: $SCRIPT_DIR"
echo ""

# Step 1: Pull latest code
echo "📥 Step 1: Pulling latest code from repository..."
if git pull; then
    echo "✅ Code pulled successfully"
else
    echo "❌ Failed to pull code"
    exit 1
fi
echo ""

# Step 2: Install dependencies
echo "📦 Step 2: Installing dependencies..."
if npm ci; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi
echo ""

# Step 3: Build the project
echo "🔨 Step 3: Building the project..."
if npm run build; then
    echo "✅ Build completed successfully"
else
    echo "❌ Build failed"
    exit 1
fi
echo ""

# Step 4: Restart Email Service
echo "📧 Step 4: Restarting Email Service..."
if systemctl is-enabled omnitools-email >/dev/null 2>&1; then
    if systemctl restart omnitools-email; then
        echo "✅ Email service restarted successfully"
    else
        echo "⚠️  Failed to restart email service"
    fi
else
    echo "⚠️  Email service not installed (omnitools-email)"
fi
echo ""

# Step 5: Reload Nginx
echo "🔄 Step 5: Reloading Nginx..."
if systemctl reload nginx; then
    echo "✅ Nginx reloaded successfully"
else
    echo "⚠️  Failed to reload Nginx (may not be running or installed)"
fi
echo ""

echo "=========================================="
echo "✨ Upgrade completed successfully!"
echo "=========================================="
