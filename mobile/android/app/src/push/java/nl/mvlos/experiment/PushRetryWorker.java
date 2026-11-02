package nl.mvlos.experiment;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Deletes registrations that were revoked on the phone but not yet on the server (Disconnect while
 * offline), with the revocation credential kept for that (delete-only, at most 30 days). Retries
 * while any is left; a 204/200 (done) or a 401/404 (the server no longer knows it) clears the record.
 */
public final class PushRetryWorker extends Worker {
    public PushRetryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        PushState state = PushStore.get(getApplicationContext());
        boolean left = false;
        for (PushState.Pending p : state.pending()) {
            PushApi.Result r = PushApi.bearer("DELETE", p.origin, "/api/push/native", p.revocationKey, null);
            if (r.status == 204 || r.status == 200 || r.status == 401 || r.status == 404) state.dropPending(p.rid);
            else left = true;
        }
        return left && getRunAttemptCount() < 20 ? Result.retry() : Result.success();
    }
}
