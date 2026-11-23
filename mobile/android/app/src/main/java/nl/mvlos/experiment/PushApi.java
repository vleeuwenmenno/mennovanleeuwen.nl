package nl.mvlos.experiment;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The app's calls to the server's push API (server/nativepush.ts). Origin-bound: the caller passes
 * the saved, allow-listed origin and nothing else is ever contacted; no redirects are followed;
 * short timeouts; answers are read up to a small limit. Never logs credentials, tokens or bodies.
 */
final class PushApi {
    /** What came back. `status` 0 means the network failed. */
    static final class Result {
        final int status;
        final JSONObject body;

        Result(int status, JSONObject body) {
            this.status = status;
            this.body = body;
        }

        boolean ok() {
            return status >= 200 && status < 300;
        }
    }

    private static final int MAX = 16 * 1024;

    private PushApi() {}

    /** The session-cookie steps: prepare and activate (from the cloud process, which holds the cookies). */
    static Result sessionPost(String origin, String path, String cookie, String uid, JSONObject body) {
        return call("POST", origin, path, cookie, null, uid, body);
    }

    /** The registration's own credential (`rid.secret`): token, content, revoke. */
    static Result bearer(String method, String origin, String path, String credential, JSONObject body) {
        return call(method, origin, path, null, credential, null, body);
    }

    private static Result call(String method, String origin, String path, String cookie, String bearer, String uid, JSONObject body) {
        HttpURLConnection c = null;
        try {
            ServerUrl.Result checked = ServerUrl.normalize(origin);
            // Credentials only ever go to an origin this build allows, whoever asks.
            if (!checked.ok() || !checked.origin.equals(origin) || !PushOrigins.allowed(BuildConfig.PUSH_ORIGINS, origin) || !path.startsWith("/api/push/native")) return new Result(0, null);
            c = (HttpURLConnection) new URL(origin + path).openConnection();
            c.setRequestMethod(method);
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setUseCaches(false);
            c.setRequestProperty("X-MvL-App-Push", "1");
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            if (uid != null) c.setRequestProperty("X-MvL-Account", uid);
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = c.getResponseCode();
            JSONObject json = null;
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                try (InputStream s = in) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] chunk = new byte[2048];
                    int n;
                    while ((n = s.read(chunk)) > 0 && buf.size() < MAX) buf.write(chunk, 0, n);
                    if (buf.size() > 0 && buf.size() < MAX) {
                        try {
                            json = new JSONObject(buf.toString("UTF-8"));
                        } catch (Exception ignored) {
                            json = null;
                        }
                    }
                }
            }
            return new Result(status, json);
        } catch (Exception e) {
            return new Result(0, null);
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
