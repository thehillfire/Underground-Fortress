package com.fortress.launcher;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
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

import java.net.HttpURLConnection;
import java.net.URL;

/**
 * One tap on "Fortress": wake the server inside Termux (in the background, no Termux window),
 * wait until it answers, then open the Fortress web app. The only thing this app can ask Termux
 * to run is the fixed `fortress start` command below.
 */
public class MainActivity extends Activity {
    static final String SERVER = "http://127.0.0.1:4321";
    static final String PERM = "com.termux.permission.RUN_COMMAND";
    static final String SETUP_CMD = "mkdir -p ~/.termux && grep -q '^allow-external-apps' ~/.termux/termux.properties 2>/dev/null || echo 'allow-external-apps=true' >> ~/.termux/termux.properties && termux-reload-settings";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status, detail;
    private Button action;
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

        TextView title = new TextView(this);
        title.setText("FORTRESS");
        title.setTextColor(Color.parseColor("#ff3b2a"));
        title.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        title.setTextSize(26);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        status = new TextView(this);
        status.setTextColor(Color.parseColor("#d8d4cc"));
        status.setTypeface(Typeface.MONOSPACE);
        status.setTextSize(18);
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
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = pad;
        root.addView(action, lp);
        setContentView(root);
    }

    @Override protected void onResume() { super.onResume(); cancelled = false; begin(); }
    @Override protected void onPause() { super.onPause(); cancelled = true; }

    private void show(String s, String d) { ui.post(() -> { status.setText(s); detail.setText(d == null ? "" : d); }); }
    private void offer(String label, Runnable r) {
        ui.post(() -> { action.setText(label); action.setVisibility(View.VISIBLE); action.setOnClickListener(v -> r.run()); });
    }
    private void hideOffer() { ui.post(() -> action.setVisibility(View.GONE)); }

    private boolean installed(String pkg) {
        try { getPackageManager().getPackageInfo(pkg, 0); return true; } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    private void begin() {
        if (running) return;
        hideOffer();
        if (!installed("com.termux")) {
            show("Termux isn't installed", "The fortress runs inside Termux. Install it from F-Droid (not the Play Store), then come back.");
            offer("GET TERMUX", () -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux/"))));
            return;
        }
        if (checkSelfPermission(PERM) != PackageManager.PERMISSION_GRANTED) {
            show("One permission needed", "Allow \"Run commands in Termux environment\" so Fortress can wake itself.");
            requestPermissions(new String[]{PERM}, 1);
            return;
        }
        running = true;
        show("Waking the fortress…", "");
        new Thread(this::wakeAndOpen, "wake").start();
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) { begin(); return; }
        show("Permission denied", "Open this app's permissions and allow \"Run commands in Termux environment\".");
        offer("OPEN SETTINGS", () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
    }

    private boolean healthy() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(SERVER + "/api/health").openConnection();
            c.setConnectTimeout(1200); c.setReadTimeout(1500);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) { return false; }
    }

    private void wakeAndOpen() {
        try {
            if (healthy()) { openApp(); return; }
            String err = sendWake();
            if (err != null) { fail(err); return; }
            long start = System.currentTimeMillis();
            while (!cancelled && System.currentTimeMillis() - start < 150_000) {
                if (healthy()) { openApp(); return; }
                long s = (System.currentTimeMillis() - start) / 1000;
                show("Waking the fortress…", s + "s" + (s > 20 ? "  (first start after a reboot is slower)" : ""));
                try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
            }
            if (!cancelled) fail("It didn't wake up.\nIf you haven't signed in to Claude yet, open Termux once and finish the sign-in.");
        } finally { running = false; }
    }

    /** Ask Termux to run `fortress start` in the background. Returns an error text or null. */
    private String sendWake() {
        try {
            Intent i = new Intent("com.termux.RUN_COMMAND");
            i.setClassName("com.termux", "com.termux.app.RunCommandService");
            i.putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash");
            i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-lc", "FORTRESS_QUIET=1 FORTRESS_NO_AUTOSTART=1 fortress start"});
            i.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home");
            i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
            startForegroundService(i);
            return null;
        } catch (SecurityException e) {
            return "Termux refused the request.\nOpen Termux once and paste this, then try again:\n\n" + SETUP_CMD;
        } catch (Exception e) {
            return "Couldn't reach Termux: " + e.getMessage();
        }
    }

    private void fail(String msg) {
        show("Couldn't wake it", msg);
        offer("TRY AGAIN", () -> { running = false; begin(); });
    }

    /** Open the installed Fortress web app if there is one, else the page in Chrome. */
    private void openApp() {
        show("Opening…", "");
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
            Intent v = new Intent(Intent.ACTION_VIEW, Uri.parse(SERVER));
            if (installed("com.android.chrome")) v.setPackage("com.android.chrome");
            startActivity(v);
            finish();
        });
    }
}
