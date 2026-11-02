package nl.mvlos.experiment;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Bundle;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.concurrent.TimeUnit;

/**
 * What only the owner (main process) does with the push state: report it, enroll, revoke. Every
 * state change and every notification post goes through LOCK, so a revoke cannot be overtaken by a
 * notification that was already on its way.
 */
final class PushOwner {
    static final Object LOCK = new Object();
    static final String WORK_TAG = "mvlos_push";
    static final String CHANNEL = "mvlos_default";

    private PushOwner() {}

    static Bundle status(Context c) {
        PushState s = PushStore.get(c);
        PushState.Snapshot snap = s.snapshot();
        Bundle b = new Bundle();
        b.putBoolean("enabled", snap.enabled);
        b.putString("origin", snap.origin);
        b.putString("uid", snap.uid);
        b.putString("rid", snap.rid);
        b.putLong("gen", snap.generation);
        b.putString("install", s.installId());
        return b;
    }

    /** The user confirmed, the server activated: this registration is the current one now. */
    static boolean enroll(Context c, String origin, String uid, String rid, String capability, String revocationKey) {
        if (!PushOrigins.allowed(BuildConfig.PUSH_ORIGINS, origin)) return false;
        synchronized (LOCK) {
            try {
                PushStore.get(c).enroll(origin, uid, rid, capability, revocationKey);
            } catch (RuntimeException e) {
                return false;
            }
            channel(c);
            try {
                FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            } catch (RuntimeException ignored) {
                // Firebase is not configured: nothing will ever arrive; the registration stays harmless.
            }
        }
        uploadToken(c);
        return true;
    }

    /** Stops everything now (state first, then the rest), then tries the server for the delete-only records. */
    static void revoke(Context c) {
        synchronized (LOCK) {
            PushStore.get(c).revoke();
            try {
                WorkManager.getInstance(c).cancelAllWorkByTag(WORK_TAG);
            } catch (RuntimeException ignored) {
                // Work manager not ready: the workers check the state themselves.
            }
            NotificationManagerCompat.from(c).cancelAll();
            try {
                // Auto-init off BEFORE the token is deleted, or the SDK would make a new one.
                FirebaseMessaging m = FirebaseMessaging.getInstance();
                m.setAutoInitEnabled(false);
                m.deleteToken();
            } catch (RuntimeException ignored) {
                // Not configured.
            }
        }
        retryPending(c);
    }

    /** Sends the device token for the current registration (idempotent; never creates one). */
    static void uploadToken(Context c) {
        PushState.Snapshot s = PushStore.get(c).snapshot();
        if (!s.enabled) return;
        Data in = new Data.Builder().putLong("gen", s.generation).putString("rid", s.rid).build();
        WorkManager.getInstance(c).enqueue(new OneTimeWorkRequest.Builder(PushTokenWorker.class)
            .setInputData(in).addTag(WORK_TAG)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }

    /** Deletes registrations that were revoked locally, with the delete-only key, in the background. */
    static void retryPending(Context c) {
        final Context app = c.getApplicationContext();
        new Thread(() -> {
            PushState state = PushStore.get(app);
            for (PushState.Pending p : state.pending()) {
                PushApi.Result r = PushApi.bearer("DELETE", p.origin, "/api/push/native", p.rid + "." + p.revocationKey, null);
                // 204: done. 401/404: the server does not know it (the session ended): done too.
                if (r.status == 204 || r.status == 200 || r.status == 401 || r.status == 404) state.dropPending(p.rid);
            }
        }).start();
    }

    static void channel(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, c.getString(R.string.push_channel), NotificationManager.IMPORTANCE_DEFAULT));
    }
}
