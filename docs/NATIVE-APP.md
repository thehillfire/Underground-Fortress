# Native app plan: the fortress as its own Android app

Goal: tap one icon, the fortress starts and stays up. No Termux window, no
manual start, no waiting. The app owns the server.

## Why Termux is the weak point

- Claude Code only runs on Linux. Termux provides a Linux userland (via proot-distro Ubuntu) and the fortress server runs inside it.
- Android treats Termux as an ordinary app. When memory runs low, Android closes it, and the server dies with it.
- `termux-wake-lock` keeps the CPU awake; it does not stop Android from closing the app.
- A foreground service owned by our own app is treated far better than a background process inside another app.

## What the native app has to do

1. Ship the Linux pieces inside the APK (or download them once on first run):
   - a proot binary,
   - an Ubuntu root filesystem,
   - Node.js, the fortress code, and Claude Code, installed into that filesystem.
2. Run the fortress server from a **foreground service** in our app, starting it through proot.
3. Keep the foreground notification visible while the server runs, with a Stop action.
4. Restart the server from the service if it exits (the current watchdog logic moves here).
5. Open the web UI from the app's main screen.

## Findings so far (checked, not guessed)

- [Certain] Claude Code ships as a **native binary per platform**, not as JavaScript. The `linux-arm64-musl` build is
  248 MB, aarch64, and dynamically linked against **musl** libc (`/lib/ld-musl-aarch64.so.1`). It does not need Ubuntu.
  This removes proot and the Ubuntu rootfs from the plan, provided we can supply a musl C library on the phone.
- [Certain] The fortress server is Node.js. Official Node.js builds for Linux arm64 are **glibc**, which won't run on Android
  (bionic). We need a Node.js built for musl or for Android.
- [Certain] This sandbox cannot run arm64 programs (no emulator) and cannot reach Alpine's package mirror, Termux's
  package repository, or F-Droid. Only the phone can test arm64 execution.
- [Likely] Zig (0.17.0, on PyPI) includes musl's C sources and can cross-compile for aarch64-linux-musl. That is the
  route to a musl libc we control. It is unverified until it runs on the phone.

## Remaining blockers for option 1

1. A musl libc for arm64, bundled in the app (from Zig's musl sources, or another source). Needed to run Claude.
2. A musl-linked or Android-linked Node.js, bundled in the app, to run the fortress server. Or the server gets ported.
3. First-run download of the Claude binary from the npm registry on the phone.
4. Battery design: no wake lock; the service sleeps when nothing is working; a cap on concurrent agents (3 by default, already built).

## Open questions (answered by a spike, not by guessing)

| # | Question | Why it matters | How to find out |
|---|----------|----------------|-----------------|
| 1 | Can an APK execute binaries it ships? | Android restricts execution of files in app storage. | Ship a tiny static binary as `lib*.so` (Android extracts these as executable) and run it from the service. |
| 2 | Can proot run an Ubuntu rootfs from the app's private storage? | Termux does this already; we need the same from our package. | Run `proot -r <rootfs> /bin/echo hi` from the service. |
| 3 | Does the Claude Code binary run inside that rootfs on arm64? | This is the Claude requirement. | Run `claude --version` through proot. |
| 4 | Does a foreground service keep the server alive with the screen off, on this Samsung? | This is the whole point. | Run for 8 hours with the screen off and check uptime. |
| 5 | How big is the first-run download? | The rootfs is hundreds of megabytes. | Measure the rootfs once packed. |

## Spike order

1. Questions 1 and 2: a minimal app that starts a proot shell from its service. Pass/fail on the phone.
2. Question 3: install Claude Code into the rootfs and run `claude --version`.
3. Question 4: run the fortress under the service with the screen off for 8 hours.
4. Only after 1–4 pass: build the real app (first-run install, UI, updates).

If question 1 or 2 fails, the plan falls back to option 2 (the server on a computer or always-on machine) and we say so, rather than stacking workarounds.

## Not decided yet

- Whether the first-run download comes from GitHub Releases or is bundled.
- Whether updates of the fortress code ship through the app or through `git pull` inside the rootfs.
