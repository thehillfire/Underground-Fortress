package com.fortress.spike;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/** Start/stop the spike, watch the log, and share the report back. */
public class MainActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status, log;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0b0a0c"));
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("FORTRESS SPIKE");
        title.setTextColor(Color.parseColor("#ff3b2a"));
        title.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        title.setTextSize(20);
        root.addView(title);

        status = text(15, "#d8d4cc");
        root.addView(status);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(button("START", v -> start()));
        row.addView(button("STOP", v -> stop()));
        root.addView(row);

        LinearLayout row2 = new LinearLayout(this);
        row2.setOrientation(LinearLayout.HORIZONTAL);
        row2.addView(button("SHARE REPORT", v -> share()));
        row2.addView(button("BATTERY SETTINGS", v -> openBattery()));
        root.addView(row2);

        ScrollView sv = new ScrollView(this);
        log = text(12, "#8a867f");
        sv.addView(log);
        root.addView(sv, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        ui.removeCallbacksAndMessages(null);
        ui.post(new Runnable() {
            @Override public void run() {
                List<String> lines = SpikeLog.tail(MainActivity.this, 60);
                log.setText(String.join("\n", lines));
                status.setText(lines.isEmpty() ? "Not started yet. Press START." : "Last: " + lines.get(lines.size() - 1));
                ui.postDelayed(this, 2000);
            }
        });
    }

    private void start() {
        SpikeLog.line(this, "START pressed");
        Intent i = new Intent(this, SpikeService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
    }

    private void stop() {
        Intent i = new Intent(this, SpikeService.class).setAction(SpikeService.ACTION_STOP);
        startService(i);
    }

    private void share() {
        StringBuilder sb = new StringBuilder("Fortress spike report\n");
        for (String s : SpikeLog.tail(this, 400)) sb.append(s).append('\n');
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, sb.toString());
        startActivity(Intent.createChooser(send, "Share report"));
    }

    private void openBattery() {
        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
    }

    private Button button(String label, android.view.View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        b.setLayoutParams(lp);
        return b;
    }

    private TextView text(int size, String color) {
        TextView t = new TextView(this);
        t.setTextColor(Color.parseColor(color));
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextSize(size);
        t.setGravity(Gravity.START);
        return t;
    }
}
