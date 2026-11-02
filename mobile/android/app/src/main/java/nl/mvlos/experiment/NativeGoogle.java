package nl.mvlos.experiment;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import org.json.JSONObject;

/**
 * The server side of the app's native Google sign-in (server/appLogin.ts): the account picker is
 * Android's own (Credential Manager, in CloudActivity); this asks the server for a one-time
 * challenge, binds it to the server the app is connected to, and redeems Google's ID token for
 * session cookies. Only native code ever holds the token; it goes to the connected server only, in
 * one request without redirects, never to the page.
 *
 * <p>Only offered for servers this build trusts (BuildConfig.NATIVE_GOOGLE_ORIGINS, from the
 * gradle property mvlosNativeGoogleOrigins): native sign-in needs an Android OAuth client for this
 * package and signing key in the same Google Cloud project as the server, which only the owner's
 * deployment has. Every other server keeps the browser flow.
 */
final class NativeGoogle {
    private NativeGoogle() {}

    /** Whether this build offers native Google sign-in for that server. */
    static boolean allowedOrigin(String origin) {
        if (origin == null) return false;
        for (String o : BuildConfig.NATIVE_GOOGLE_ORIGINS.split(",")) {
            if (origin.equals(o.trim())) return true;
        }
        return false;
    }

    /** The nonce for Google: base64url(SHA-256(challenge + "\n" + origin)), exactly what the server expects. */
    static String nonce(String challenge, String origin) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest((challenge + "\n" + origin).getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** What a redeem gave: session cookies (checked), or the server's reason for refusing. */
    static final class Result {
        final List<String> cookies;
        final String error;
        final String reason;
        /** The server's short reason for refusing a token (which check failed), for the dialog and logs. */
        final String detail;

        Result(List<String> cookies, String error, String reason) {
            this(cookies, error, reason, null);
        }

        Result(List<String> cookies, String error, String reason, String detail) {
            this.cookies = cookies;
            this.error = error;
            this.reason = reason;
            this.detail = detail;
        }
    }

    /** POST /api/auth/app/google/start: a one-time challenge, or null. Off the main thread. */
    static String start(String origin) {
        HttpURLConnection c = null;
        try {
            c = post(origin + "/api/auth/app/google/start", "{}", null);
            if (c.getResponseCode() != 200) return null;
            String challenge = new JSONObject(CloudLogin.read(c.getInputStream(), 4096)).optString("challenge", "");
            return challenge.matches("[A-Za-z0-9_-]{43}") ? challenge : null;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** POST /api/auth/app/google/redeem with the challenge and Google's ID token. Off the main thread. */
    static Result redeem(String origin, String challenge, String idToken, String cookie) {
        HttpURLConnection c = null;
        try {
            String body = new JSONObject().put("challenge", challenge).put("idToken", idToken).toString();
            c = post(origin + "/api/auth/app/google/redeem", body, cookie);
            int status = c.getResponseCode();
            if (status == 200) {
                List<String> set = c.getHeaderFields().get("Set-Cookie");
                if (set == null) set = c.getHeaderFields().get("set-cookie");
                List<String> cookies = CloudLogin.validCookies(set);
                return cookies != null ? new Result(cookies, null, null) : new Result(null, "error", null);
            }
            JSONObject refusal = new JSONObject(CloudLogin.read(c.getErrorStream(), 4096));
            String error = refusal.optString("error", "error");
            String reason = refusal.optString("reason", "");
            String detail = refusal.optString("detail", "");
            return new Result(null, error.matches("[a-z-]{1,20}") ? error : "error", reason.isEmpty() ? null : reason,
                detail.matches("[a-z ]{1,40}") ? detail : null);
        } catch (Exception e) {
            return new Result(null, "unreachable", null, null);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static HttpURLConnection post(String url, String body, String cookie) throws java.io.IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setUseCaches(false);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("X-MvL-App-Redeem", "1");
        if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
        try (OutputStream out = c.getOutputStream()) {
            out.write(body.getBytes(StandardCharsets.UTF_8));
        }
        return c;
    }
}
