package nl.mvlos.experiment;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Firebase's door, in the MAIN process only (never touches cookies or the cloud process). A
 * message is dropped unless it is exactly {v, rid, nid, k}, came from this app's Firebase sender,
 * and names the CURRENT registration; a foreign message changes nothing. It starts a unique
 * expedited fetch (no network call inside the short callback).
 */
public class MvlosMessagingService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        PushPayload payload = PushPayload.parse(message.getData());
        if (payload == null) return;
        String sender = FirebaseApp.getInstance().getOptions().getGcmSenderId();
        if (sender == null || !sender.equals(message.getFrom())) return;
        PushState.Snapshot s = PushStore.get(this).snapshot();
        if (!s.enabled || !payload.rid.equals(s.rid) || !PushOrigins.allowed(BuildConfig.PUSH_ORIGINS, s.origin)) return;
        Data in = new Data.Builder().putLong("gen", s.generation).putString("rid", payload.rid).putString("nid", payload.nid).putLong("at", System.currentTimeMillis()).build();
        WorkManager.getInstance(this).enqueueUniqueWork("push-" + payload.nid, ExistingWorkPolicy.KEEP, new OneTimeWorkRequest.Builder(PushFetchWorker.class)
            .setInputData(in).addTag(PushOwner.WORK_TAG)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build());
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // The token rotated: the current registration gets the new one. Never creates a registration.
        PushOwner.uploadToken(this);
    }
}
