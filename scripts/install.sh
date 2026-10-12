#!/data/data/com.termux/files/usr/bin/bash
# One-paste installer for Termux:
#   curl -fsSL https://raw.githubusercontent.com/thehillfire/Underground-Fortress/HEAD/scripts/install.sh | bash
# Downloads the fortress, sets everything up, signs you in to Claude, and opens the game.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
PKG_OPTS=(-y -o Dpkg::Options::=--force-confnew)
DIR="$HOME/fortress"

printf '\n\033[1;31m▌ UNDERGROUND FORTRESS — installing (10–15 min, keep the screen on)\033[0m\n'
pkg update "${PKG_OPTS[@]}" >/dev/null 2>&1 || pkg update "${PKG_OPTS[@]}"
pkg install "${PKG_OPTS[@]}" git >/dev/null

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only
else git clone --depth 1 https://github.com/thehillfire/Underground-Fortress "$DIR"; fi

bash "$DIR/scripts/phone-setup.sh" --auto </dev/tty
