#!/bin/bash
# Safe Scratchy restart — only kills the Node server, never the tunnel
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find and kill ONLY the node process LISTENING on port 3001
LISTEN_PID=$(lsof -iTCP:3001 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$LISTEN_PID" ]; then
    echo "Killing Scratchy server (PID $LISTEN_PID)..."
    kill "$LISTEN_PID" 2>/dev/null || true
    sleep 2
fi

# Verify port is free
if lsof -iTCP:3001 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Port 3001 still in use, force killing..."
    kill -9 "$(lsof -iTCP:3001 -sTCP:LISTEN -t)" 2>/dev/null || true
    sleep 1
fi

# Start server
cd "$SCRIPT_DIR"
nohup node serve.js > /tmp/scratchy.log 2>&1 &
sleep 2

# Verify
if grep -q "running" /tmp/scratchy.log; then
    echo "✅ Scratchy running (PID $(lsof -iTCP:3001 -sTCP:LISTEN -t 2>/dev/null))"
else
    echo "❌ Scratchy failed to start:"
    cat /tmp/scratchy.log
    exit 1
fi
