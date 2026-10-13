#!/data/data/com.termux/files/usr/bin/bash
# Stop Android from killing Termux's background processes ("phantom process killer", Android 12 and 13).
# Run inside Termux:  fortress fix-killer
# One time, on this phone only. Uses Android's own Wireless debugging to give Termux the permission to change the setting.
set -e
say() { printf '\n\033[1;31m▌ %s\033[0m\n' "$*"; }
pkg install -y android-tools >/dev/null 2>&1 || true
say "Step 1: turn on Wireless debugging"
echo "  Settings -> Developer options -> Wireless debugging -> ON  (if you don't see Developer options: Settings -> About phone -> tap Build number 7 times)"
echo "  Then tap 'Pair device with pairing code'. Keep that popup open."
read -r -p "  Pairing address (like 192.168.1.5:41234): " PAIR
read -r -p "  Pairing code (6 digits): " CODE
adb pair "$PAIR" "$CODE"
say "Step 2: connect"
echo "  Close the popup. On the Wireless debugging screen, read 'IP address & Port'."
read -r -p "  IP address & port (like 192.168.1.5:37555): " HOST
adb connect "$HOST"
say "Step 3: turn the killer off"
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent" || true
adb shell "/system/bin/device_config put activity_manager max_phantom_processes 2147483647" || true
adb shell settings put global settings_enable_monitor_phantom_procs false || true
adb shell "dumpsys activity settings | grep -i phantom" || true
adb disconnect >/dev/null 2>&1 || true
say "Done. You can turn Wireless debugging off again. Restart the phone once for good measure."
