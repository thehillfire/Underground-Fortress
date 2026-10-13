package com.fortress.spike;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The spike. Starts the bundled program (libfortresslet.so) as a child process, checks it every 30 seconds,
 * restarts it if it exits, and writes battery and uptime to the log. No wake lock: the point is to measure
 * what a foreground service costs when the phone is idle.
 */
public class SpikeService extends Service {
    static final String ACTION_STOP = "com.fortress.spike.STOP";
    static final String CHANNEL = "spike";
    private static final int ID = 42;
    private static final long EVERY_MS = 30_000;
    private static final int PORT = 4330;

    private HandlerThread thread;
    private Handler handler;
    private Process child;
    private int restarts = 0;
    private long startedAt = 0;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            SpikeLog.line(this, "STOP pressed. Service stopping.");
            stopChild();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (thread != null) return START_STICKY;   // already running
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Spike", NotificationManager.IMPORTANCE_LOW));
        startForeground(ID, note("Spike running"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        startedAt = System.currentTimeMillis();
        SpikeLog.line(this, "SERVICE START. Foreground service up. Child program: " + binary().getAbsolutePath()
                + " exists=" + binary().exists() + " exec=" + binary().canExecute());
        thread = new HandlerThread("spike");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(this::tick);
        return START_STICKY;
    }

    private File binary() {
        return new File(getApplicationInfo().nativeLibraryDir, "libfortresslet.so");
    }

    private void tick() {
        try {
            if (child == null || !child.isAlive()) {
                if (child != null) {
                    SpikeLog.line(this, "CHILD EXITED with code " + safeExit() + ". Restarting.");
                    restarts++;
                }
                startChild();
            }
            boolean ok = healthy();
            SpikeLog.line(this, "CHECK child=" + (child != null && child.isAlive() ? "alive" : "dead")
                    + " health=" + (ok ? "ok" : "FAIL") + " restarts=" + restarts + " " + battery()
                    + " up=" + ((System.currentTimeMillis() - startedAt) / 60000) + "min");
            getSystemService(NotificationManager.class).notify(ID, note("Up " + ((System.currentTimeMillis() - startedAt) / 60000)
                    + " min · battery " + batteryPercent() + "% · restarts " + restarts));
        } catch (Exception e) {
            SpikeLog.line(this, "TICK ERROR " + e);
        }
        handler.postDelayed(this::tick, EVERY_MS);
    }

    private void startChild() throws Exception {
        File bin = binary();
        if (!bin.exists()) { SpikeLog.line(this, "NO BINARY at " + bin); return; }
        ProcessBuilder pb = new ProcessBuilder(bin.getAbsolutePath());
        pb.redirectErrorStream(true);
        pb.directory(getFilesDir());
        child = pb.start();
        SpikeLog.line(this, "CHILD STARTED pid=" + pid(child));
        Process p = child;
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String s;
                while ((s = r.readLine()) != null) SpikeLog.line(this, "child: " + s);
            } catch (Exception ignored) {}
        }, "child-log");
        reader.setDaemon(true);
        reader.start();
        Thread.sleep(1500);
    }

    private boolean healthy() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/health").openConnection();
            c.setConnectTimeout(2000);
            c.setReadTimeout(2000);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private void stopChild() {
        if (child != null) child.destroy();
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        thread = null;
    }

    @Override public void onDestroy() {
        SpikeLog.line(this, "SERVICE DESTROYED");
        stopChild();
        super.onDestroy();
    }

    private int safeExit() { try { return child.exitValue(); } catch (Exception e) { return -1; } }

    /** Process.pid() only exists on newer Android; ask for it by reflection so the app runs on older ones too. */
    private static long pid(Process p) {
        try { return (Long) Process.class.getMethod("pid").invoke(p); } catch (Throwable t) { return -1; }
    }

    /** "battery 73% (charging no) · 412 mA now": the drain is the number that matters. */
    private String battery() {
        BatteryManager bm = getSystemService(BatteryManager.class);
        int pct = batteryPercent();
        long uA = bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW);
        return "battery=" + pct + "% now=" + (uA / 1000) + "mA";
    }

    private int batteryPercent() {
        return getSystemService(BatteryManager.class).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    }

    private Notification note(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, SpikeService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("Fortress Spike")
                .setContentText(text)
                .setContentIntent(openPi)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stopPi).build())
                .build();
    }
}
