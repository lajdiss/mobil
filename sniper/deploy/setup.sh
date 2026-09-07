#!/usr/bin/env bash
#
# Sets up the sniper on a fresh Debian or Ubuntu VPS.
#
#   curl -fsSL https://raw.githubusercontent.com/lajdiss/mobil/claude/plzen-dating-app-wu5ryb/sniper/deploy/setup.sh | sudo bash
#
# Installs Node, clones the repo, creates a locked-down .env, and registers a
# systemd service so the bot comes back after a reboot. It does NOT start the
# bot: you still have to add your private key by hand.

set -euo pipefail

REPO_URL="https://github.com/lajdiss/mobil.git"
BRANCH="claude/plzen-dating-app-wu5ryb"
INSTALL_DIR="/opt/sniper"
SERVICE_USER="sniper"
PORT="8787"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

echo "==> Installing dependencies"
apt-get update -qq
apt-get install -y -qq curl git ufw ca-certificates gnupg >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

echo "==> Creating service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> Fetching the code"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard --quiet "origin/$BRANCH"
else
  rm -rf "$INSTALL_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Installing npm packages"
cd "$INSTALL_DIR/sniper"
npm install --silent --no-audit --no-fund

ENV_FILE="$INSTALL_DIR/sniper/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo "==> Keeping the existing .env"
else
  echo "==> Writing .env"
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  cp "$INSTALL_DIR/sniper/.env.example" "$ENV_FILE"
  sed -i "s|^DASHBOARD_TOKEN=.*|DASHBOARD_TOKEN=$TOKEN|" "$ENV_FILE"
fi

# The private key lives in here, so nobody but the service user may read it.
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 600 "$ENV_FILE"

echo "==> Installing the systemd service"
# systemd needs an absolute ExecStart, and npm's path differs between distros.
NPM_PATH="$(command -v npm)"
sed "s|^ExecStart=.*|ExecStart=$NPM_PATH start|" \
  "$INSTALL_DIR/sniper/deploy/sniper.service" > /etc/systemd/system/sniper.service
chmod 644 /etc/systemd/system/sniper.service
systemctl daemon-reload
systemctl enable --quiet sniper.service

# Plain HTTP over the public internet would put the dashboard token on the wire in
# clear text, so the port stays closed and Tailscale is the way in.
echo "==> Locking down the firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw deny "$PORT" >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

TOKEN_VALUE="$(grep '^DASHBOARD_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"

cat <<EOF

========================================================================
 Installed, but NOT started — the bot has no wallet key yet.

 1. Add your burner wallet key:

      sudo nano $ENV_FILE

    Fill in PRIVATE_KEY. Leave DRY_RUN=true for the first run.

 2. Check that the pump.fun instructions still match mainnet:

      cd $INSTALL_DIR/sniper && sudo -u $SERVICE_USER npm run verify

 3. Start it:

      sudo systemctl start sniper
      sudo journalctl -u sniper -f

 4. Reach the dashboard from your phone. Port $PORT is firewalled off the
    public internet on purpose, so join the server to a private network:

      curl -fsSL https://tailscale.com/install.sh | sudo sh
      sudo tailscale up
      sudo ufw allow in on tailscale0 to any port $PORT

    Install Tailscale on the iPhone, sign in with the same account, then
    open the server's Tailscale IP in Safari:

      http://<tailscale-ip>:$PORT/?token=$TOKEN_VALUE

 Your dashboard token:
   $TOKEN_VALUE
========================================================================

EOF
