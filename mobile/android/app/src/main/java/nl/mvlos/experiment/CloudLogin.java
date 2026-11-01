package nl.mvlos.experiment;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.json.JSONObject;

/**
 * Signing in the cloud desktop through the system browser (server/appLogin.ts on the server).
 *
 * <p>The app keeps a random PKCE verifier and state for one sign-in at a time, in the cloud
 * process's private preferences, for ten minutes. The browser is opened at the server's
 * /api/auth/app/start with only the challenge (SHA-256 of the verifier) and the state. The server
 * answers on nl.mvlos.experiment:/oauth with a one-time code; AuthReturnActivity checks the state,
 * and CloudActivity redeems the code: the app itself (not the WebView) POSTs code and verifier to
 * the same server without following redirects, checks the session cookies it gets back, and puts
 * them into the cloud WebView. The verifier never leaves the app except in that one request.
 */
final class CloudLogin {
    static final String REDIRECT_SCHEME = "nl.mvlos.experiment";
    static final String REDIRECT_PATH = "/oauth";
    private static final String FILE = "mvlos_cloud_login";
    private static final long TTL_MS = 10 * 60_000L;
    private static final SecureRandom RANDOM = new SecureRandom();

    /** What the server says about signing in the app. */
    enum Support { SUPPORTED, OLD_SERVER, NOT_CONFIGURED, PROVIDER_OFF, SERVER_ERROR, UNREACHABLE }

    /** The protocol version this app speaks (server/appLogin.ts APP_LOGIN_VERSION). */
    static final int PROTOCOL = 2;

    /** The only cookies a redeem may set, and which of them must be HttpOnly. */
    private static final java.util.Set<String> COOKIES = new java.util.HashSet<>(java.util.Arrays.asList("mvlos_sid", "mvlos_uid", "mvlos_login"));

    /** One sign-in in progress. */
    static final class Pending {
        final String state;
        final String verifier;
        final String origin;
        final String provider;
        final long createdAt;

        Pending(String state, String verifier, String origin, String provider, long createdAt) {
            this.state = state;
            this.verifier = verifier;
            this.origin = origin;
            this.provider = provider;
            this.createdAt = createdAt;
        }

        boolean live() {
            long age = System.currentTimeMillis() - createdAt;
            return age >= 0 && age < TTL_MS;
        }
    }

    private CloudLogin() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String random(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /**
     * The challenge for this verifier and server: base64url(SHA-256(verifier + "\n" + origin)). The
     * server checks it with its own configured address, so a server that relays the code and the
     * verifier to another server gets nothing there.
     */
    static String challenge(String verifier, String origin) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest((verifier + "\n" + origin).getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(hash, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Starts a sign-in: remembers a fresh state and verifier, and returns the browser address. */
    static String begin(Context context, String origin, String provider) {
        String state = random(16);
        String verifier = random(32);
        prefs(context).edit()
            .putString("state", state).putString("verifier", verifier).putString("origin", origin)
            .putString("provider", provider).putLong("created", System.currentTimeMillis())
            .commit();
        return origin + "/api/auth/app/start?provider=" + provider + "&challenge=" + challenge(verifier, origin) + "&state=" + state;
    }

    /** The sign-in in progress, if any and still fresh. */
    static Pending pending(Context context) {
        SharedPreferences p = prefs(context);
        String state = p.getString("state", null);
        if (state == null) return null;
        Pending pending = new Pending(state, p.getString("verifier", ""), p.getString("origin", ""), p.getString("provider", ""), p.getLong("created", 0));
        return pending.live() ? pending : null;
    }

    /** Takes the sign-in in progress out (it is used once), if any and still fresh. */
    static Pending take(Context context) {
        Pending pending = pending(context);
        clear(context);
        return pending;
    }

    static void clear(Context context) {
        prefs(context).edit().clear().commit();
    }

    /** Compares two strings in time that doesn't depend on where they differ. */
    static boolean same(String a, String b) {
        if (a == null || b == null) return false;
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    /** Asks the server (GET /api/auth/app) whether it signs in the app with this provider. Off the main thread. */
    static Support support(String origin, String provider) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(origin + "/api/auth/app").openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            c.setRequestProperty("Accept", "application/json");
            c.setUseCaches(false);
            int status = c.getResponseCode();
            // Older servers answer 401 or 404 here (or the desktop page); a server error is something else.
            if (status >= 500) return Support.SERVER_ERROR;
            if (status != 200) return Support.OLD_SERVER;
            String type = c.getContentType();
            if (type == null || !type.startsWith("application/json")) return Support.OLD_SERVER;
            JSONObject body = new JSONObject(read(c.getInputStream(), 16 * 1024));
            int version = body.optInt("app", -1);
            // 0: a current server without an https PUBLIC_URL; 1: an earlier, unbound protocol.
            if (version == 0) return Support.NOT_CONFIGURED;
            if (version < PROTOCOL) return Support.OLD_SERVER;
            // The server's own idea of its address must be the one the app connects to.
            if (!origin.equals(body.optString("origin", ""))) return Support.NOT_CONFIGURED;
            JSONObject providers = body.optJSONObject("providers");
            return providers != null && providers.optBoolean(provider, false) ? Support.SUPPORTED : Support.PROVIDER_OFF;
        } catch (Exception e) {
            return Support.UNREACHABLE;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * Redeems the code (POST /api/auth/app/redeem, JSON, header X-MvL-App-Redeem) and returns the
     * session cookies the server set, each checked: only MvL OS's own cookies, Secure, Path=/, no
     * Domain, the session one HttpOnly. Null if anything is off. Off the main thread.
     * `cookie`: what the cloud WebView had for this server, so the server ends that old session.
     */
    static java.util.List<String> redeem(String origin, String code, String verifier, String cookie) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(origin + "/api/auth/app/redeem").openConnection();
            c.setRequestMethod("POST");
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setUseCaches(false);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("X-MvL-App-Redeem", "1");
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            JSONObject body = new JSONObject().put("code", code).put("verifier", verifier);
            try (java.io.OutputStream out = c.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (c.getResponseCode() != 200) return null;
            java.util.List<String> set = c.getHeaderFields().get("Set-Cookie");
            if (set == null) set = c.getHeaderFields().get("set-cookie");
            return validCookies(set);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * Checks the Set-Cookie headers of a redeem and returns canonical ones to install: only MvL OS's
     * own cookies, each once; every attribute parsed (names trimmed, case-insensitive), each once;
     * Secure and Path=/ required, no Domain, the session cookie HttpOnly. The cookies installed are
     * rebuilt from the checked parts, never the headers as received.
     */
    static java.util.List<String> validCookies(java.util.List<String> set) {
        if (set == null) return null;
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        for (String header : set) {
            String[] parts = header.split(";", -1);
            int eq = parts[0].indexOf('=');
            if (eq <= 0) return null;
            String name = parts[0].substring(0, eq).trim();
            String value = parts[0].substring(eq + 1).trim();
            if (!COOKIES.contains(name) || out.containsKey(name) || !value.matches("[A-Za-z0-9%._~-]{1,512}")) return null;
            java.util.Map<String, String> attrs = new java.util.HashMap<>();
            for (int i = 1; i < parts.length; i++) {
                String part = parts[i];
                int e = part.indexOf('=');
                String key = (e < 0 ? part : part.substring(0, e)).trim().toLowerCase(java.util.Locale.ROOT);
                String val = e < 0 ? "" : part.substring(e + 1).trim();
                if (key.isEmpty() || attrs.containsKey(key)) return null;
                attrs.put(key, val);
            }
            if (attrs.containsKey("domain") || !"/".equals(attrs.get("path")) || !attrs.containsKey("secure")) return null;
            boolean httpOnly = attrs.containsKey("httponly");
            if (name.equals("mvlos_sid") && !httpOnly) return null;
            String maxAge = attrs.get("max-age");
            if (maxAge != null && !maxAge.matches("[0-9]{1,9}")) return null;
            for (String k : attrs.keySet()) {
                if (!k.matches("path|secure|httponly|max-age|samesite|expires")) return null;
            }
            out.put(name, name + "=" + value + "; Path=/" + (maxAge != null ? "; Max-Age=" + maxAge : "")
                + "; Secure" + (httpOnly ? "; HttpOnly" : "") + "; SameSite=Lax");
        }
        return out.containsKey("mvlos_sid") && out.containsKey("mvlos_uid") ? new java.util.ArrayList<>(out.values()) : null;
    }


    static String read(InputStream in, int max) throws java.io.IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > max) throw new java.io.IOException("too large");
            }
            return out.toString("UTF-8");
        }
    }
}
