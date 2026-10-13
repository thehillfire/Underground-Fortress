package com.fortress.launcher;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * The watchdog. While it runs, the fortress is kept alive: every 20 seconds it checks that the server
 * answers, and when it doesn't (Android killed Termux, a crash, a reboot) it asks Termux to start it again.
 * It shows one quiet notification, and holds the CPU awake so the checks keep running with the screen off.
 */
public class KeepAliveService extends Service {
    static final String CHANNEL = "watchdog";
    static final String ACTION_STOP = "com.fortress.launcher.STOP";
    static final String PREFS = "fortress";
    static final String KEY_ON = "watchdog_on";
    private static final int ID = 7;
    private static final long EVERY_MS = 20_000;

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock lock;
    private int misses = 0;
    private long lastWake = 0;
    private int wakes = 0;
    private String lastText = "";

    static void start(Context c) {
        c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ON, true).apply();
        try { c.startForegroundService(new Intent(c, KeepAliveService.class)); } catch (Exception ignored) {}
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ON, false).apply();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Fortress watchdog", NotificationManager.IMPORTANCE_LOW));
        startForeground(ID, note("Watching the fortress…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        if (lock == null) {
            lock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fortress:watchdog");
            lock.acquire();
        }
        if (thread == null) {
            thread = new HandlerThread("watchdog");
            thread.start();
            handler = new Handler(thread.getLooper());
            handler.post(this::tick);
        }
        return START_STICKY;
    }

    private void tick() {
        long now = System.currentTimeMillis();
        if (Fortress.healthy()) {
            misses = 0;
            show(wakes == 0 ? "Fortress is running" : "Fortress is running (restarted " + wakes + "×)");
        } else {
            misses++;
            // Two misses in a row (about 40 s), and not more often than once a minute: start it again.
            if (misses >= 2 && now - lastWake > 60_000) {
                lastWake = now;
                wakes++;
                show("Fortress stopped. Waking it…");
                Fortress.wake(this);
            } else if (misses >= 1) {
                show("Checking the fortress…");
            }
        }
        handler.postDelayed(this::tick, EVERY_MS);
    }

    private void show(String text) {
        if (text.equals(lastText)) return;
        lastText = text;
        getSystemService(NotificationManager.class).notify(ID, note(text));
    }

    private Notification note(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, KeepAliveService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("Fortress")
                .setContentText(text)
                .setContentIntent(openPi)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop watching", stopPi).build())
                .build();
    }

    @Override public void onDestroy() {
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (thread != null) thread.quitSafely();
        if (lock != null && lock.isHeld()) lock.release();
        super.onDestroy();
    }
}
