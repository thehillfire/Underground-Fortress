package com.fortress.spike;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** One log file in the app's private storage. The service writes it; the screen and the share button read it. */
final class SpikeLog {
    private static final int KEEP_LINES = 400;
    private static final Object LOCK = new Object();

    private SpikeLog() {}

    static File file(Context c) { return new File(c.getFilesDir(), "spike.log"); }

    static void line(Context c, String text) {
        String stamp = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date());
        synchronized (LOCK) {
            File f = file(c);
            try (Writer w = new OutputStreamWriter(new FileOutputStream(f, true), StandardCharsets.UTF_8)) {
                w.write(stamp + "  " + text + "\n");
            } catch (IOException ignored) {}
            if (f.length() > 200_000) trim(f);
        }
    }

    static List<String> tail(Context c, int n) {
        List<String> out = new ArrayList<>();
        synchronized (LOCK) {
            try {
                for (String s : Files.readAllLines(file(c).toPath(), StandardCharsets.UTF_8)) out.add(s);
            } catch (IOException ignored) {}
        }
        return out.subList(Math.max(0, out.size() - n), out.size());
    }

    private static void trim(File f) {
        try {
            List<String> all = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
            List<String> keep = all.subList(Math.max(0, all.size() - KEEP_LINES), all.size());
            Files.write(f.toPath(), keep, StandardCharsets.UTF_8);
        } catch (IOException ignored) {}
    }
}
