# Native app spike: procedure

Purpose: decide whether a foreground service in our own Android app keeps a program running
on this phone without draining the battery. This is the first of the five questions in
docs/NATIVE-APP.md. It does NOT yet test the Linux layer (proot + Ubuntu + Claude Code).

## What the spike app does
- Starts a small arm64 program (`libfortresslet.so`, built in CI from `android-spike/fortresslet`).
- Checks it every 30 seconds, restarts it if it exits, and writes battery % and current draw to a log.
- Uses **no wake lock**, so the phone can sleep between checks. That is the battery-friendly case we want to measure.

## Install
1. Open the fortress app → SETUP → (the spike link appears once CI publishes it), or open
   `public/downloads/fortress-spike.apk` from the repo on GitHub and download it.
2. Install it. If Android asks, allow installs from the browser you used.
3. Open **Fortress Spike**. Allow notifications.

## Test (about 2 hours total)
1. Note the battery % now. Press **START**. Confirm the log shows `SERVICE START` and `CHILD STARTED`.
2. Press **BATTERY SETTINGS** → set Fortress Spike to **Unrestricted** (the spike needs this to be fair).
3. Lock the screen. Leave the phone alone for **60 minutes** with the screen off, on normal Wi-Fi.
4. Unlock. Open the app and press **SHARE REPORT**. Send me the report.
5. Also note the battery % at the end and check Settings → Battery → app usage for "Fortress Spike".
6. Press **STOP** when done.

## Pass criteria (decided before the test, not after)
- The child program is still running at the end (`CHECK child=alive` on every check) with **zero restarts**.
- Battery drop over the hour attributed to Fortress Spike is **under 5%** (target to be confirmed;
  if the number is higher we record it and find out where it goes before building on it).
- The log has a `CHECK` line roughly every 30 seconds for the whole hour (gaps mean Android paused us).

## Reading the result
- Restarts > 0 or `CHILD EXITED` lines: Android is killing the child. Note the time and what the phone was doing.
- Gaps in the CHECK lines: Android is pausing the service (deep sleep).
- High drain with zero restarts and steady checks: the foreground service itself costs too much, and we
  look at what the check loop is doing before anything else.

## Next (only if the spike passes)
- Phase B: run the Linux layer (proot + Ubuntu rootfs + Claude Code) inside this same service.
  The sandbox can't reach Termux's proot package, so the app will download it on the phone at first run.
