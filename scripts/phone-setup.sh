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
export DEBIAN_FRONTEND=noninteractive
AUTO="${1:-}"

APP="$(cd "$(dirname "$0")/.." && pwd)"
DISTRO=ubuntu
say() { printf '\n\033[1;31m▌ %s\033[0m\n' "$*"; }

say "[1/4] Termux packages"
pkg update -y -o Dpkg::Options::=--force-confnew
pkg install -y -o Dpkg::Options::=--force-confnew proot-distro git termux-tools termux-api

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
  command -v git >/dev/null || { apt-get update; apt-get install -y git; }
  git config --global --add safe.directory /root/fortress
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
signed_in() { inside 'test -s ~/.claude/.credentials.json || test -n "\$CLAUDE_CODE_OAUTH_TOKEN"'; }
login() {
  printf '\n\033[1;31m▌ Sign in to Claude\033[0m\n  Type  /login  → pick your Claude account (Pro/Max, NOT API key)\n  Chrome opens by itself → Authorize → Copy code → paste it back here → type  /exit\n  (If Chrome does not open: press  c  to copy the link and paste it into Chrome.)\n\n'
  rm -f "\$APP/.open-url"
  # Claude runs inside Ubuntu and cannot open Chrome; it drops the URL in a file and we open it.
  ( while :; do
      if [ -s "\$APP/.open-url" ]; then termux-open-url "\$(head -n1 "\$APP/.open-url")"; rm -f "\$APP/.open-url"; fi
      sleep 1
    done ) &
  local watcher=\$!
  inside 'mkdir -p ~/.fortress-bin && for b in xdg-open sensible-browser www-browser; do ln -sf /root/fortress/scripts/open-url ~/.fortress-bin/\$b; done; BROWSER=/root/fortress/scripts/open-url PATH=~/.fortress-bin:\$PATH claude'
  kill \$watcher 2>/dev/null || true
}
case "\${1:-start}" in
  login)  login ;;
  update) git -C "\$APP" pull --ff-only && bash "\$APP/scripts/phone-setup.sh" ;;
  mock|start)
    if curl -s -m 2 -o /dev/null http://127.0.0.1:4321/api/health; then
      echo "The fortress is already running."; termux-open-url http://127.0.0.1:4321; exit 0
    fi
    if [ "\${1:-start}" = start ] && ! signed_in; then login; fi
    termux-wake-lock || true
    # Actions the app may ask Termux to do. A fixed list: the app can never run arbitrary commands here.
    rm -f "\$APP/.termux-action"
    ( while :; do
        if [ -s "\$APP/.termux-action" ]; then
          read -r act arg < "\$APP/.termux-action"; rm -f "\$APP/.termux-action"
          case "\$act" in
            open-url) case "\$arg" in http://*|https://*) termux-open-url "\$arg" ;; esac ;;
            keep-alive) termux-wake-lock || true; am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:com.termux >/dev/null 2>&1 ;;
            notify) command -v termux-notification >/dev/null && termux-notification --id fortress-lidia --title Lidia --content "\$arg" --priority high --action "termux-open-url http://127.0.0.1:4321" || true ;;
          esac
        fi
        sleep 1
      done ) &
    watcher=\$!
    (sleep 7; termux-open-url http://127.0.0.1:4321) &
    while :; do
      if [ "\${1:-start}" = mock ]; then inside 'cd /root/fortress && FORTRESS_MOCK=1 exec node server/index.js'; else inside 'cd /root/fortress && exec node server/index.js'; fi
      code=\$?
      [ "\$code" = 75 ] && { echo "Restarting the fortress…"; continue; }               # restart / code update
      [ "\$code" = 76 ] && { kill \$watcher 2>/dev/null; exec bash "\$APP/scripts/phone-setup.sh" --auto; }  # setup changed: rerun it
      break
    done
    kill \$watcher 2>/dev/null || true
    termux-wake-unlock || true ;;
  *) sed -n '2,6p' "\$0" ;;
esac
LAUNCH
chmod +x "$PREFIX/bin/fortress"

# Opening Termux starts the fortress (and opens the app) unless it's already running.
if ! grep -q 'fortress-autostart' "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'RC'
# fortress-autostart: open Termux and the fortress starts by itself
if [ -z "$FORTRESS_NO_AUTOSTART" ] && [ -t 1 ] && command -v fortress >/dev/null; then
  curl -s -m 2 -o /dev/null http://127.0.0.1:4321/api/health || fortress start
fi
RC
fi

if [ "$AUTO" = --auto ]; then
  say "Installed. Signing you in to Claude, then the game opens."
  echo "  Next time just open Termux: the fortress starts by itself."
  exec "$PREFIX/bin/fortress" start
fi

say "Done. Open a new Termux session (or type  fortress) and the game starts."
