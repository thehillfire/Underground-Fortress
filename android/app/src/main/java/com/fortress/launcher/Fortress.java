package com.fortress.launcher;

import android.content.Context;
import android.content.Intent;

import java.net.HttpURLConnection;
import java.net.URL;

/** Shared bits: is the fortress answering, and how to ask Termux to start it. */
final class Fortress {
    static final String SERVER = "http://127.0.0.1:4321";
    static final String SETUP_CMD = "mkdir -p ~/.termux && grep -q '^allow-external-apps' ~/.termux/termux.properties 2>/dev/null || echo 'allow-external-apps=true' >> ~/.termux/termux.properties && termux-reload-settings";

    private Fortress() {}

    static boolean healthy() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(SERVER + "/api/health").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1500);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /** Ask Termux to run `fortress start` in the background. Returns an error text, or null if it was sent. */
    static String wake(Context ctx) {
        try {
            Intent i = new Intent("com.termux.RUN_COMMAND");
            i.setClassName("com.termux", "com.termux.app.RunCommandService");
            i.putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash");
            i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-lc", "FORTRESS_QUIET=1 FORTRESS_NO_AUTOSTART=1 fortress start"});
            i.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home");
            i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
            ctx.startForegroundService(i);
            return null;
        } catch (SecurityException e) {
            return "Termux refused the request.\nOpen Termux once and paste this, then try again:\n\n" + SETUP_CMD;
        } catch (Exception e) {
            return "Couldn't reach Termux: " + e.getMessage();
        }
    }
}
