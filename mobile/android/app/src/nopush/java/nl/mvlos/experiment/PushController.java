package nl.mvlos.experiment;

import android.app.Activity;
import android.content.Context;

/** Push notifications are not part of this build (no -PmvlosPush): everything here does nothing. */
final class PushController {
    private PushController() {}

    static boolean available(Context context, String origin) {
        return false;
    }

    static String userAgentSuffix(Context context, String origin) {
        return "";
    }

    static void startOptIn(Activity from, String origin) {}

    /** Main process. */
    static void revokeLocal(Context context) {}

    /** Any process, not on the main thread: whether the owner acknowledged. Nothing to revoke here, so true. */
    static boolean revokeBlocking(Context context) {
        return true;
    }

    /** Cloud process: the page's session is the one push was enabled for, or push is revoked. */
    static void checkSession(Context context, String origin, String uidCookie) {}

    static void retryPending(Context context) {}
}
