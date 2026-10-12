#!/data/data/com.termux/files/usr/bin/bash
# Underground Fortress: run everything on an Android phone, on your Claude subscription.
#
# In Termux (install it from F-Droid, not the Play Store):
#   pkg install -y git && git clone https://github.com/thehillfire/Underground-Fortress ~/fortress && bash ~/fortress/scripts/phone-setup.sh
#
# Claude Code has no Android build, so this installs a small Ubuntu userland
# (proot-distro) where the Linux arm64 build runs. You sign in with your Claude
# account once (no API key). Afterwards just type:  fortress
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
DISTRO=ubuntu
say() { printf '\n\033[1;31m▌ %s\033[0m\n' "$*"; }

say "[1/4] Termux packages"
pkg update -y
pkg install -y proot-distro git termux-tools

say "[2/4] Ubuntu userland (one time, ~300 MB)"
if ! proot-distro login "$DISTRO" -- true 2>/dev/null; then
  proot-distro install "$DISTRO"
fi

say "[3/4] Node.js, Claude Code and the fortress inside Ubuntu"
proot-distro login "$DISTRO" --bind "$APP:/root/fortress" -- bash -lc '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  major=$(node -p "process.versions.node.split(\".\")[0]" 2>/dev/null || echo 0)
  if [ "$major" -lt 20 ]; then
    apt-get update
    apt-get install -y curl ca-certificates git
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
  cd /root/fortress && npm install --no-audit --no-fund
'

say "[4/4] Installing the  fortress  command"
cat > "$PREFIX/bin/fortress" <<LAUNCH
#!/data/data/com.termux/files/usr/bin/bash
# fortress          start the fortress and open it
# fortress login    sign in to Claude (your subscription)
# fortress update   pull the latest version
# fortress mock     start with fake sessions (no Claude usage)
APP="$APP"
inside() { proot-distro login $DISTRO --bind "\$APP:/root/fortress" -- bash -lc "\$1"; }
case "\${1:-start}" in
  login)  inside 'claude' ;;
  update) git -C "\$APP" pull --ff-only && inside 'cd /root/fortress && npm install --no-audit --no-fund' ;;
  mock|start)
    termux-wake-lock || true
    (sleep 7; termux-open-url http://127.0.0.1:4321) &
    if [ "\${1:-start}" = mock ]; then inside 'cd /root/fortress && npm run mock'; else inside 'cd /root/fortress && npm start'; fi
    termux-wake-unlock || true ;;
  *) sed -n '2,6p' "\$0" ;;
esac
LAUNCH
chmod +x "$PREFIX/bin/fortress"

say "Done. Now sign in to Claude:"
cat <<'MSG'
  1. Run:  fortress login
  2. In Claude, type  /login  and choose your Claude account (Pro/Max subscription), NOT an API key.
  3. Long-press the link it prints, open it, approve, paste the code back. Then type  /exit
  4. Run:  fortress     (the game opens in Chrome; ⋮ → Add to Home screen to install it)
MSG
