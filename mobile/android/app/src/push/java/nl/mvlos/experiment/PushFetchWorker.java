package nl.mvlos.experiment;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;

/**
 * Turns an opaque push (a registration id and a notification id) into a notification: fetches the
 * content once, with the capability, under the generation the message arrived in, and shows it
 * only if that registration is still the current one. Anything but a success shows NOTHING: a 404
 * (unknown, used, expired, switched off since) and a 401 (revoke here) are final; only a network
 * failure retries, and only while the content could still be waiting on the server.
 */
public final class PushFetchWorker extends Worker {
    private static final long DEADLINE_MS = 10 * 60_000;

    public PushFetchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        PushState state = PushStore.get(c);
        long gen = getInputData().getLong("gen", -1);
        String rid = getInputData().getString("rid");
        String nid = getInputData().getString("nid");
        long arrived = getInputData().getLong("at", 0);
        if (rid == null || nid == null || !state.isCurrent(gen, rid)) return Result.success();
        // Origin, registration and capability in one read under this generation, or nothing.
        PushState.Credential cred = state.credential(gen, rid);
        if (cred == null) return Result.success();
        PushApi.Result r = PushApi.bearer("GET", cred.origin, "/api/push/native/notification/" + nid, cred.capability, null);
        if (r.status == 401) {
            PushOwner.revokeIfCurrent(c, gen, rid);
            return Result.success();
        }
        if (r.status == 0 || r.status >= 500) {
            return getRunAttemptCount() < 4 && System.currentTimeMillis() - arrived < DEADLINE_MS ? Result.retry() : Result.success();
        }
        if (!r.ok() || r.body == null) return Result.success();
        try {
            JSONObject b = r.body;
            String path = PushDeepLink.validate(b.optString("path", "/"));
            String title = clip(b.optString("title", ""), 200);
            String text = clip(b.optString("body", ""), 500);
            if (path == null || title.isEmpty()) return Result.success();
            // Checked and posted under the same lock a revoke takes: a revoke cannot be overtaken.
            synchronized (PushOwner.LOCK) {
                if (state.isCurrent(gen, rid)) PushNotifier.post(c, rid, nid, gen, title, text, path);
            }
        } catch (RuntimeException ignored) {
            // Nothing is shown on anything unreadable.
        }
        return Result.success();
    }

    private static String clip(String s, int max) {
        String cleaned = s.replaceAll("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "");
        return cleaned.length() > max ? cleaned.substring(0, max) : cleaned;
    }
}
