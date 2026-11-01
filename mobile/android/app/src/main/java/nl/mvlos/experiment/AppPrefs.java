package nl.mvlos.experiment;

import android.content.Context;
import android.content.SharedPreferences;

/** The launcher's remembered choice: mode, saved server origin and auto-open. Private to the app. */
final class AppPrefs {
    static final String MODE_LOCAL = "local";
    static final String MODE_CLOUD = "cloud";

    private static final String FILE = "mvlos_launcher";
    private static final String KEY_MODE = "mode";
    private static final String KEY_SERVER = "server";
    private static final String KEY_AUTO = "auto";

    private AppPrefs() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String mode(Context context) {
        return prefs(context).getString(KEY_MODE, null);
    }

    static void setMode(Context context, String mode) {
        prefs(context).edit().putString(KEY_MODE, mode).apply();
    }

    /** The saved server origin, re-validated so a tampered or stale value is never used. */
    static String server(Context context) {
        String saved = prefs(context).getString(KEY_SERVER, null);
        if (saved == null) return null;
        ServerUrl.Result result = ServerUrl.normalize(saved);
        return result.ok() ? result.origin : null;
    }

    static void setCloud(Context context, String origin) {
        prefs(context).edit().putString(KEY_SERVER, origin).putString(KEY_MODE, MODE_CLOUD).apply();
    }

    /** Forgets the saved server in the app. Does not touch the browser's session for that site. */
    static void forgetServer(Context context) {
        SharedPreferences.Editor editor = prefs(context).edit().remove(KEY_SERVER);
        if (MODE_CLOUD.equals(mode(context))) editor.remove(KEY_MODE);
        editor.apply();
    }

    static boolean autoOpen(Context context) {
        return prefs(context).getBoolean(KEY_AUTO, false);
    }

    static void setAutoOpen(Context context, boolean auto) {
        prefs(context).edit().putBoolean(KEY_AUTO, auto).apply();
    }
}
