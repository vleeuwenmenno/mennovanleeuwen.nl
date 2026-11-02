package nl.mvlos.experiment;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * Sends this device's FCM token for the current registration (also after the token rotated). It
 * only updates a registration that exists: a 401 (the server no longer knows it) turns push OFF
 * here. It re-checks the generation before and after every step.
 */
public final class PushTokenWorker extends Worker {
    public PushTokenWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        PushState state = PushStore.get(c);
        long gen = getInputData().getLong("gen", -1);
        String rid = getInputData().getString("rid");
        if (rid == null || !state.isCurrent(gen, rid)) return Result.success();
        try {
            String token = Tasks.await(FirebaseMessaging.getInstance().getToken(), 30, TimeUnit.SECONDS);
            // Origin, registration and capability in one read under this generation, or nothing.
            PushState.Credential cred = state.credential(gen, rid);
            if (cred == null || token == null) return Result.success();
            PushApi.Result r = PushApi.bearer("PUT", cred.origin, "/api/push/native/token", cred.capability, new JSONObject().put("token", token));
            if (r.status == 204 || r.status == 200) return Result.success();
            if (r.status == 401) {
                PushOwner.revokeIfCurrent(c, gen, rid);
                return Result.success();
            }
            if (r.status == 409) {
                // The token is another registration's (a restored copy): make a new one, only if this is still the current registration.
                PushOwner.deleteTokenIfCurrent(c, gen, rid);
                return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
            }
            return r.status == 0 || r.status >= 500 ? (getRunAttemptCount() < 6 ? Result.retry() : Result.failure()) : Result.failure();
        } catch (Exception e) {
            return getRunAttemptCount() < 6 ? Result.retry() : Result.failure();
        }
    }
}
