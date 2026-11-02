package nl.mvlos.experiment;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The only addresses a push notification may open in the cloud desktop: the server's own home, or
 * an app of a short list with ids. Plain Java so it runs in local JUnit tests. It mirrors the
 * server's list (server/nativepush.ts nativePath) and re-checks it here: the path is rebuilt in a
 * fixed order from what was understood, never passed on as it came. Nothing is decoded: percent
 * signs, '@', backslashes, fragments, repeated keys and anything unknown make it invalid.
 */
public final class PushDeepLink {
    private static final Pattern UUID = Pattern.compile("^[0-9a-f-]{36}$");
    private static final Pattern SAFE = Pattern.compile("^[A-Za-z0-9/?=&_.~-]{1,512}$");
    private static final List<String> APPS = Arrays.asList("agents", "tasks", "mail", "calendar");

    private PushDeepLink() {}

    private static List<String> keysOf(String app) {
        switch (app) {
            case "agents":
                return Arrays.asList("thread", "task", "run");
            case "tasks":
                return Arrays.asList("task");
            default:
                return Arrays.<String>asList();
        }
    }

    /** The canonical path, or null when it is not one a notification may open. */
    public static String validate(String path) {
        if (path == null) return null;
        if (path.equals("/")) return "/";
        if (!SAFE.matcher(path).matches() || !path.startsWith("/?open=")) return null;
        String[] parts = path.substring(2).split("&", -1);
        String app = null;
        java.util.Map<String, String> values = new java.util.HashMap<>();
        Set<String> seen = new HashSet<>();
        for (String part : parts) {
            int eq = part.indexOf('=');
            if (eq <= 0 || eq == part.length() - 1 || part.indexOf('=', eq + 1) >= 0) return null;
            String key = part.substring(0, eq);
            String value = part.substring(eq + 1);
            if (!seen.add(key)) return null;
            if (key.equals("open")) app = value;
            else values.put(key, value);
        }
        if (app == null || !APPS.contains(app)) return null;
        List<String> allowed = keysOf(app);
        StringBuilder out = new StringBuilder("/?open=").append(app);
        for (String key : allowed) {
            String value = values.remove(key);
            if (value == null) continue;
            if (!UUID.matcher(value).matches()) return null;
            out.append('&').append(key).append('=').append(value);
        }
        return values.isEmpty() ? out.toString() : null;
    }
}
