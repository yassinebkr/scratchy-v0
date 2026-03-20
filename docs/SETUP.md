# Scratchy VPS Setup Guide

Everything you need to go from a fresh Debian/Ubuntu VPS to a running Scratchy instance with secure remote access.

---

## 1. Prerequisites

Before you start, you need:

- **A VPS** — Contabo, Hetzner, DigitalOcean, or similar. Minimum 1 vCPU, 1 GB RAM, Debian 12 or Ubuntu 22.04+.
- **SSH access** — your provider gives you a root login (IP + password or key).
- **A domain** (optional) — only needed if you want Cloudflare tunnel with a custom domain. SSH tunnel works without one.
- **Your local machine** — any OS with an SSH client and a browser.

**Cost:** A Contabo VPS with 4 vCPU / 6 GB RAM runs about €4.50/month. That is more than enough.

---

## 2. VPS Initial Setup

### SSH into your server

```bash
# From your local machine
ssh root@YOUR_SERVER_IP
```

### Create a non-root user

```bash
# Create user with home directory
adduser openclaw

# Give sudo access
usermod -aG sudo openclaw
```

### Set up SSH key authentication

```bash
# On your LOCAL machine, generate a key (skip if you already have one)
ssh-keygen -t ed25519 -C "your-email@example.com"

# Copy it to the server
ssh-copy-id openclaw@YOUR_SERVER_IP
```

### Disable password login

```bash
# On the server, edit SSH config
sudo nano /etc/ssh/sshd_config

# Set these values:
#   PasswordAuthentication no
#   PermitRootLogin no

# Restart SSH
sudo systemctl restart sshd
```

> ⚠️ **Test your key login in a new terminal before closing the current session.** If the key does not work, you will lock yourself out.

### Set up the firewall

```bash
# Allow SSH
sudo ufw allow OpenSSH

# Enable firewall (say yes when prompted)
sudo ufw enable

# Verify
sudo ufw status
```

> 🛑 **Do NOT open ports 3001 or 28945 in the firewall.** Scratchy and the OpenClaw gateway should only be accessible via tunnel — never directly from the internet.

---

## 3. Install Node.js 22+

Switch to your non-root user first:

```bash
su - openclaw
```

### Option A: nvm (recommended)

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Load nvm into current shell
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node.js 22
nvm install 22

# Verify
node --version  # Should show v22.x.x
```

### Option B: NodeSource

```bash
# Add NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

# Install
sudo apt-get install -y nodejs

# Verify
node --version
```

---

## 4. Install OpenClaw

```bash
# Clone the repository
git clone https://github.com/openclaw/openclaw.git ~/.openclaw/repo

# Enter the directory
cd ~/.openclaw/repo

# Install dependencies
npm install

# Link the CLI globally
npm link

# Run the onboarding wizard
openclaw onboard
```

The onboard wizard will walk you through:
- Accepting the license
- Setting a gateway token (save this — you will need it for Scratchy)
- Configuring your AI model provider

---

## 5. Configure OpenClaw

### Gateway token

The onboard wizard sets a token automatically. To view or change it:

```bash
# View current config
cat ~/.openclaw/openclaw.json

# Or check via CLI
openclaw status
```

The token is at `gateway.auth.token` in the JSON. **Save this token** — you need it to log into Scratchy.

### Model setup

Edit `~/.openclaw/openclaw.json` to set your model provider. Anthropic Claude is recommended:

```json
{
  "gateway": {
    "auth": {
      "token": "your-gateway-token"
    }
  },
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "sk-ant-..."
  }
}
```

> You can also configure models through the onboard wizard or by running `openclaw config`.

### Verify the gateway starts

```bash
# Start the gateway
openclaw gateway start

# Check status
openclaw gateway status

# Stop it for now (we will set up systemd later)
openclaw gateway stop
```

---

## 6. Install Scratchy

```bash
# Clone the repository
git clone https://github.com/yassinebkr/scratchy-v0.git ~/scratchy

# Enter the directory
cd ~/scratchy

# Install dependencies
npm install
```

That is it. Scratchy has zero build steps.

---

## 7. Start Everything

### Start the OpenClaw gateway

```bash
openclaw gateway start
```

### Start Scratchy

```bash
cd ~/scratchy
node serve.js
```

You should see:

```
Scratchy server running at http://localhost:3001

  Login URL (click to open):
  http://localhost:3001/?token=your-auto-detected-token
```

Scratchy auto-detects the gateway token from `~/.openclaw/openclaw.json` when running on the same machine. No extra configuration needed.

> 🛑 **Scratchy is now listening on localhost:3001.** It is not accessible from the internet because the firewall blocks it. That is correct. You access it through a tunnel (next section).

---

## 8. Remote Access

You are on a VPS. Scratchy listens on localhost. You need a tunnel to reach it from your browser.

### Method 1: SSH Tunnel (recommended)

No third party, no extra software on the server, encrypted by default.

```bash
# On your LOCAL machine, run:
ssh -L 3001:localhost:3001 openclaw@YOUR_SERVER_IP

# This forwards your local port 3001 → server's localhost:3001
# Now open http://localhost:3001 in your browser
```

To run the tunnel in the background:

```bash
# Background tunnel (no shell)
ssh -fN -L 3001:localhost:3001 openclaw@YOUR_SERVER_IP

# To stop it later:
kill $(lsof -t -i :3001)
```

> On Windows, use PuTTY or Windows Terminal with the same `ssh -L` command (Windows 10+ has OpenSSH built in).

### Method 2: Cloudflare Tunnel

Gives you a public URL (useful for mobile access or sharing). Requires a free Cloudflare account.

#### Install cloudflared on the server

```bash
# Download and install
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb
```

#### Quick tunnel (temporary URL, no domain needed)

```bash
# Generates a random *.trycloudflare.com URL
cloudflared tunnel --url http://localhost:3001
```

Cloudflared prints a URL like `https://random-words.trycloudflare.com`. Open it in your browser.

> ⚠️ **Quick tunnels are public.** Anyone with the URL can see the login page. The gateway token still protects access, but do not share the URL.

#### Named tunnel (permanent, custom domain)

```bash
# Authenticate with Cloudflare
cloudflared tunnel login

# Create a tunnel
cloudflared tunnel create scratchy

# Configure it
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: scratchy
credentials-file: /home/openclaw/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: scratchy.yourdomain.com
    service: http://localhost:3001
  - service: http_status:404
EOF

# Add DNS record (replace with your actual hostname)
cloudflared tunnel route dns scratchy scratchy.yourdomain.com

# Run the tunnel
cloudflared tunnel run scratchy
```

> 🔒 Cloudflare tunnels encrypt traffic end-to-end. No ports need to be opened in the firewall.

---

## 9. First Login

1. Open your browser and go to `http://localhost:3001` (SSH tunnel) or your Cloudflare URL.
2. You will see the Scratchy login page.
3. Paste your **OpenClaw gateway token** and click login.
4. You should see the chat interface with a connected status indicator.

**Where to find your token:**

```bash
# On the server:
openclaw status
# or
cat ~/.openclaw/openclaw.json | grep token
```

If Scratchy and OpenClaw run on the same server, you can also click the direct login URL printed when Scratchy starts — it includes the token as a query parameter.

---

## 10. Running as Services

So far everything runs in the foreground. If you close your SSH session, it all stops. Systemd services fix that.

### OpenClaw Gateway service

```bash
sudo tee /etc/systemd/system/openclaw-gateway.service << 'EOF'
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw
# Adjust the path to your openclaw binary — find it with: which openclaw
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node /home/openclaw/.openclaw/repo/src/cli.js gateway start --foreground
Restart=on-failure
RestartSec=5
# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/openclaw/.openclaw

[Install]
WantedBy=multi-user.target
EOF
```

> **Important:** The `ExecStart` path depends on your Node.js installation. Run `which node` and `find ~/.openclaw -name cli.js` to get the correct paths. If you used NodeSource instead of nvm, the node path is `/usr/bin/node`.

### Scratchy service

```bash
sudo tee /etc/systemd/system/scratchy.service << 'EOF'
[Unit]
Description=Scratchy - OpenClaw UI
After=network.target openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw/scratchy
ExecStart=/home/openclaw/.nvm/versions/node/v22.22.0/bin/node serve.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/home/openclaw/scratchy /tmp

[Install]
WantedBy=multi-user.target
EOF
```

### Cloudflare Tunnel service (optional)

If you use a named Cloudflare tunnel:

```bash
sudo tee /etc/systemd/system/cloudflared-scratchy.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel for Scratchy
After=network.target scratchy.service
Wants=scratchy.service

[Service]
Type=simple
User=openclaw
ExecStart=/usr/bin/cloudflared tunnel run scratchy
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### Enable and start everything

```bash
# Reload systemd to pick up new unit files
sudo systemctl daemon-reload

# Enable services (start on boot)
sudo systemctl enable openclaw-gateway scratchy

# Start services now
sudo systemctl start openclaw-gateway
sudo systemctl start scratchy

# Check status
sudo systemctl status openclaw-gateway
sudo systemctl status scratchy

# View logs
journalctl -u openclaw-gateway -f
journalctl -u scratchy -f
```

---

## 11. Updating

### Update Scratchy

```bash
cd ~/scratchy

# Pull latest changes
git pull

# Install any new dependencies
npm install

# Restart the service
sudo systemctl restart scratchy
```

### Update OpenClaw

```bash
cd ~/.openclaw/repo

# Pull latest changes
git pull

# Install any new dependencies
npm install

# Restart the gateway
sudo systemctl restart openclaw-gateway
```

### One-liner update script

Save this as `~/update.sh`:

```bash
#!/bin/bash
set -e

echo "Updating OpenClaw..."
cd ~/.openclaw/repo && git pull && npm install

echo "Updating Scratchy..."
cd ~/scratchy && git pull && npm install

echo "Restarting services..."
sudo systemctl restart openclaw-gateway
sudo systemctl restart scratchy

echo "Done. Checking status..."
sudo systemctl status openclaw-gateway --no-pager -l
sudo systemctl status scratchy --no-pager -l
```

```bash
chmod +x ~/update.sh
~/update.sh
```

---

## 12. Troubleshooting

### Port conflict on 3001

```
Error: listen EADDRINUSE :::3001
```

Something else is using port 3001.

```bash
# Find what is using the port
sudo lsof -i :3001

# Kill it
sudo kill $(sudo lsof -t -i :3001)

# Or start Scratchy on a different port
node serve.js 3002
# Then adjust your SSH tunnel: ssh -L 3002:localhost:3002 ...
```

### Gateway token mismatch

Symptom: login fails, or Scratchy shows "disconnected" after login.

```bash
# Check what token OpenClaw is using
cat ~/.openclaw/openclaw.json | grep token

# Make sure it matches what you entered in the Scratchy login page
# If using SCRATCHY_TOKEN env var, it must match exactly
```

### WebSocket connection errors

Symptom: chat loads but messages do not stream, or you see reconnection attempts.

```bash
# Check the gateway is actually running
openclaw gateway status

# Check the gateway port (default 28945)
curl -s http://localhost:28945/health || echo "Gateway not responding"

# Check Scratchy logs for proxy errors
journalctl -u scratchy -n 50
```

### SSH tunnel not working

```bash
# Verify the tunnel is running on your local machine
lsof -i :3001

# If nothing shows, the tunnel died. Restart it:
ssh -fN -L 3001:localhost:3001 openclaw@YOUR_SERVER_IP

# Common cause: Scratchy is not running on the server
# SSH into the server and check:
sudo systemctl status scratchy
```

### Cloudflare tunnel issues

```bash
# Check tunnel status
cloudflared tunnel info scratchy

# Check logs
journalctl -u cloudflared-scratchy -n 50

# Common: DNS not propagated yet — wait 5 minutes after creating a new route
# Common: credentials file path wrong in config.yml
```

### Cannot connect after reboot

Services may not have started. Check:

```bash
# Are services enabled?
sudo systemctl is-enabled openclaw-gateway scratchy

# Start them if not running
sudo systemctl start openclaw-gateway
sudo systemctl start scratchy
```

### Node.js not found in systemd

If you installed Node via nvm, systemd cannot find it because nvm is a shell function.

```bash
# Find the actual node binary path
which node
# Example output: /home/openclaw/.nvm/versions/node/v22.22.0/bin/node

# Use this full path in your systemd ExecStart lines
```

### Check all logs at once

```bash
# Follow both services in one terminal
journalctl -u openclaw-gateway -u scratchy -f
```

---

## Security Checklist

Before you consider your setup complete:

- [ ] Firewall (ufw) enabled — only SSH open
- [ ] Password SSH login disabled — key-only
- [ ] Root login disabled
- [ ] Ports 3001 and 28945 are NOT open in the firewall
- [ ] Accessing Scratchy via tunnel only (SSH or Cloudflare)
- [ ] Gateway token is strong (long, random)
- [ ] Gateway token is not committed to any git repo
- [ ] Services run as non-root user

---

## Quick Reference

| What | Command |
|------|---------|
| Start gateway | `sudo systemctl start openclaw-gateway` |
| Stop gateway | `sudo systemctl stop openclaw-gateway` |
| Start Scratchy | `sudo systemctl start scratchy` |
| Stop Scratchy | `sudo systemctl stop scratchy` |
| View gateway logs | `journalctl -u openclaw-gateway -f` |
| View Scratchy logs | `journalctl -u scratchy -f` |
| Check gateway token | `cat ~/.openclaw/openclaw.json \| grep token` |
| SSH tunnel | `ssh -L 3001:localhost:3001 openclaw@SERVER_IP` |
| Update everything | `~/update.sh` |
