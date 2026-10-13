package com.fortress.launcher;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The front door. One tap: wake the fortress inside Termux (background, no Termux window), wait until it
 * answers, play a sound and say CONNECTED, start the watchdog that keeps it alive, then open the app.
 */
public class MainActivity extends Activity {
    static final String PERM = "com.termux.permission.RUN_COMMAND";
    static final String NOTIF = "android.permission.POST_NOTIFICATIONS";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView title, status, detail;
    private Button action, action2;
    private volatile boolean running = false;
    private volatile boolean cancelled = false;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#0b0a0c"));
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        title = new TextView(this);
        title.setText("FORTRESS");
        title.setTextColor(Color.parseColor("#ff3b2a"));
        title.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        title.setTextSize(30);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#d8d4cc"));
        status.setTypeface(Typeface.MONOSPACE);
        status.setTextSize(20);
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, pad, 0, pad / 2);
        root.addView(status);

        detail = new TextView(this);
        detail.setTextColor(Color.parseColor("#8a867f"));
        detail.setTypeface(Typeface.MONOSPACE);
        detail.setTextSize(14);
        detail.setGravity(Gravity.CENTER);
        root.addView(detail);

        action = new Button(this);
        action.setVisibility(View.GONE);
        action2 = new Button(this);
        action2.setVisibility(View.GONE);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = pad;
        root.addView(action, lp);
        root.addView(action2, lp);
        setContentView(root);
    }

    @Override protected void onResume() { super.onResume(); cancelled = false; begin(); }
    @Override protected void onPause() { super.onPause(); cancelled = true; }

    private void show(String s, String d, int color) {
        ui.post(() -> { status.setText(s); status.setTextColor(color); detail.setText(d == null ? "" : d); });
    }
    private void show(String s, String d) { show(s, d, Color.parseColor("#d8d4cc")); }
    private void offer(Button b, String label, Runnable r) {
        ui.post(() -> { b.setText(label); b.setVisibility(View.VISIBLE); b.setOnClickListener(v -> r.run()); });
    }
    private void hideOffers() { ui.post(() -> { action.setVisibility(View.GONE); action2.setVisibility(View.GONE); }); }

    private boolean installed(String pkg) {
        try { getPackageManager().getPackageInfo(pkg, 0); return true; } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    private void begin() {
        if (running) return;
        hideOffers();
        if (!installed("com.termux")) {
            show("Termux isn't installed", "The fortress runs inside Termux. Install it from F-Droid (not the Play Store), then come back.");
            offer(action, "GET TERMUX", () -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux/"))));
            return;
        }
        if (checkSelfPermission(PERM) != PackageManager.PERMISSION_GRANTED) {
            show("Two permissions needed", "Allow \"Run commands in Termux environment\" so Fortress can wake itself, and notifications so you can see the watchdog.");
            requestPermissions(new String[]{PERM, NOTIF}, 1);
            return;
        }
        running = true;
        show("Waking the fortress…", "");
        new Thread(this::wakeAndOpen, "wake").start();
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (checkSelfPermission(PERM) == PackageManager.PERMISSION_GRANTED) { begin(); return; }
        show("Permission denied", "Open this app's permissions and allow \"Run commands in Termux environment\".");
        offer(action, "OPEN SETTINGS", () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
    }

    private void wakeAndOpen() {
        try {
            if (!Fortress.healthy()) {
                String err = Fortress.wake(this);
                if (err != null) { fail(err); return; }
                long start = System.currentTimeMillis();
                boolean up = false;
                while (!cancelled && System.currentTimeMillis() - start < 150_000) {
                    if (Fortress.healthy()) { up = true; break; }
                    long s = (System.currentTimeMillis() - start) / 1000;
                    show("Waking the fortress…", s + "s" + (s > 20 ? "  (first start after a reboot is slower)" : ""));
                    try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
                }
                if (!up) {
                    if (!cancelled) fail("It didn't wake up.\nIf you haven't signed in to Claude yet, open Termux once and finish the sign-in.");
                    return;
                }
            }
            connected();
        } finally { running = false; }
    }

    /** The moment it answers: a sound, CONNECTED, the watchdog on, then the app. */
    private void connected() {
        show("CONNECTED", "The fortress is awake. A watchdog now keeps it that way.", Color.parseColor("#2fbf5a"));
        chime();
        KeepAliveService.start(this);
        try { Thread.sleep(1300); } catch (InterruptedException ignored) {}
        openApp();
    }

    private void chime() {
        try {
            Ringtone r = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));
            if (r != null) { r.play(); return; }
        } catch (Exception ignored) {}
        try { new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).startTone(ToneGenerator.TONE_PROP_ACK, 350); } catch (Exception ignored) {}
    }

    private void fail(String msg) {
        show("Couldn't wake it", msg);
        offer(action, "TRY AGAIN", () -> { running = false; begin(); });
        offer(action2, "BATTERY SETTINGS", () -> startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));
    }

    /** Open the installed Fortress web app if there is one, else the page in Chrome. */
    private void openApp() {
        ui.post(() -> {
            try {
                PackageManager pm = getPackageManager();
                for (PackageInfo p : pm.getInstalledPackages(0)) {
                    if (!p.packageName.startsWith("org.chromium.webapk.")) continue;
                    String label = String.valueOf(p.applicationInfo.loadLabel(pm)).toLowerCase();
                    if (!label.contains("fortress")) continue;
                    Intent li = pm.getLaunchIntentForPackage(p.packageName);
                    if (li != null) { startActivity(li); finish(); return; }
                }
            } catch (Exception ignored) {}
            Intent v = new Intent(Intent.ACTION_VIEW, Uri.parse(Fortress.SERVER));
            if (installed("com.android.chrome")) v.setPackage("com.android.chrome");
            startActivity(v);
            finish();
        });
    }
}
