package com.fortress.launcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a reboot, start the watchdog (if it was on), which starts the fortress: no Termux:Boot needed. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c, Intent i) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())) return;
        if (c.getSharedPreferences(KeepAliveService.PREFS, Context.MODE_PRIVATE).getBoolean(KeepAliveService.KEY_ON, false)) KeepAliveService.start(c);
    }
}
