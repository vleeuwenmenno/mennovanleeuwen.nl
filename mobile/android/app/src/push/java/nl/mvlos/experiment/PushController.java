package nl.mvlos.experiment;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

/**
 * What the rest of the app (CloudActivity, LauncherActivity, CloudResetActivity) knows about push.
 * This is the build WITH push (-PmvlosPush); src/nopush has an inert twin. Push is only offered for
 * an origin on the build's allow-list, and only when Firebase is configured for the build
 * (google-services.json).
 */
final class PushController {
    private PushController() {}

    private static boolean configured(Context c) {
        // Made by the google-services plugin from google-services.json; absent means no Firebase config.
        return c.getResources().getIdentifier("google_app_id", "string", c.getPackageName()) != 0;
    }

    static boolean available(Context c, String origin) {
        return PushOrigins.allowed(BuildConfig.PUSH_ORIGINS, origin) && configured(c);
    }

    /** Lets the site show the app's push opt-in (Settings → Notifications); it grants nothing. */
    static String userAgentSuffix(Context c, String origin) {
        return available(c, origin) ? " MvLOSPush/1" : "";
    }

    /** From CloudActivity, after a tap on exactly mvlosapp://push. */
    static void startOptIn(Activity from, String origin) {
        if (!available(from, origin)) {
            Toast.makeText(from, R.string.push_unavailable, Toast.LENGTH_LONG).show();
            return;
        }
        from.startActivity(new Intent(from, PushOptInActivity.class).putExtra(CloudActivity.EXTRA_ORIGIN, origin));
    }

    /** Main process: stops everything now. */
    static void revokeLocal(Context c) {
        PushOwner.revoke(c);
    }

    /** Any process, never the main thread: revoked and acknowledged by the owner. False if the owner did not answer. */
    static boolean revokeBlocking(Context c) {
        if (PushStore.isMainProcess()) {
            PushOwner.revoke(c);
            return true;
        }
        Bundle r = PushOwnerClient.call(c, PushOwnerService.OP_REVOKE, null, 5000);
        return r != null && r.getBoolean("ok");
    }

    /**
     * Cloud process, on resume: push stays only while the page's session is the one it was enabled
     * for (same origin, session cookie present, same account id); otherwise it is revoked. When it
     * is fine, the token registration is refreshed (idempotent).
     */
    static void checkSession(Context c, String origin, String cookie) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            Bundle st = PushOwnerClient.call(app, PushOwnerService.OP_STATUS, null, 3000);
            if (st == null || !st.getBoolean("enabled")) return;
            boolean sid = cookie != null && cookie.contains("mvlos_sid=");
            String uid = cookieValue(cookie, "mvlos_uid");
            if (!origin.equals(st.getString("origin")) || !sid || uid == null || !uid.equals(st.getString("uid"))) {
                // Only if it is still the registration that was looked at: a newer enrollment is not touched.
                Bundle only = new Bundle();
                only.putLong("gen", st.getLong("gen", -1));
                only.putString("rid", st.getString("rid"));
                PushOwnerClient.call(app, PushOwnerService.OP_REVOKE_IF, only, 5000);
                return;
            }
            PushOwnerClient.call(app, PushOwnerService.OP_REFRESH, null, 3000);
        }).start();
    }

    /** Not on the main thread: whether `rid` of `generation` is still the current registration for `origin` (a tap that arrives after a Disconnect is refused here). */
    static boolean stillCurrent(Context c, String origin, long generation, String rid) {
        Bundle st = PushOwnerClient.call(c, PushOwnerService.OP_STATUS, null, 3000);
        return st != null && st.getBoolean("enabled") && st.getLong("gen", -2) == generation && rid != null && rid.equals(st.getString("rid")) && origin != null && origin.equals(st.getString("origin"));
    }

    /** Main process: delete-only records that could not reach the server earlier. */
    static void retryPending(Context c) {
        PushOwner.retryPending(c);
    }

    static String cookieValue(String cookie, String name) {
        if (cookie == null) return null;
        for (String part : cookie.split(";")) {
            String p = part.trim();
            if (p.startsWith(name + "=")) return p.substring(name.length() + 1);
        }
        return null;
    }
}
