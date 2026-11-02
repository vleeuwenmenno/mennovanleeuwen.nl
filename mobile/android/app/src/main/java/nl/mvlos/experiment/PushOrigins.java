package nl.mvlos.experiment;

/**
 * The servers this build may register for push with (build-time list, `mvlosPushOrigins`). Checked
 * before any token or credential is ever sent anywhere: the server announcing the same Firebase
 * project is only a consistency check, not proof of who it is. Plain Java.
 */
public final class PushOrigins {
    private PushOrigins() {}

    /** Whether `origin` (already normalized by ServerUrl) is exactly one of the comma-separated `allowed` origins. */
    public static boolean allowed(String allowed, String origin) {
        if (allowed == null || origin == null || origin.isEmpty()) return false;
        for (String item : allowed.split(",")) {
            String entry = item.trim();
            if (entry.isEmpty()) continue;
            ServerUrl.Result r = ServerUrl.normalize(entry);
            if (r.ok() && r.origin.equals(origin)) return true;
        }
        return false;
    }
}
