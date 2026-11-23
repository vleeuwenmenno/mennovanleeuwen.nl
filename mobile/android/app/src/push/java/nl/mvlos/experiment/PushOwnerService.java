package nl.mvlos.experiment;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.Process;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The owner's door for the cloud process (which holds the cookies): status, revoke, enroll. Not
 * exported, so only this app can bind it; each message must also come from this app's uid. Replies
 * carry no secrets. Operations that touch the network or the Keystore run off the main thread.
 */
public class PushOwnerService extends Service {
    static final int OP_STATUS = 1;
    static final int OP_REVOKE = 2;
    static final int OP_ENROLL = 3;
    static final int OP_REFRESH = 4;
    /** Revoke only if the registration the caller looked at is still the current one (generation and rid in the data). */
    static final int OP_REVOKE_IF = 5;
    /** Keep a revocation credential for deletion on the server (an opt-in that could not be kept). */
    static final int OP_CLEANUP = 6;

    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper()) {
        @Override
        public void handleMessage(Message msg) {
            if (msg.sendingUid != Process.myUid() || msg.replyTo == null) return;
            final int op = msg.what;
            final Bundle in = msg.peekData();
            final Messenger to = msg.replyTo;
            work.execute(() -> {
                Bundle out = new Bundle();
                try {
                    switch (op) {
                        case OP_STATUS:
                            out = PushOwner.status(getApplicationContext());
                            break;
                        case OP_REVOKE:
                            PushOwner.revoke(getApplicationContext());
                            out.putBoolean("ok", true);
                            break;
                        case OP_ENROLL:
                            boolean ok = in != null && PushOwner.enroll(getApplicationContext(), in.getLong("gen", -1), in.getString("origin"), in.getString("uid"), in.getString("rid"), in.getString("cap"), in.getString("rev"));
                            out.putBoolean("ok", ok);
                            break;
                        case OP_REVOKE_IF:
                            if (in != null && in.getString("rid") != null) PushOwner.revokeIfCurrent(getApplicationContext(), in.getLong("gen", -1), in.getString("rid"));
                            out.putBoolean("ok", true);
                            break;
                        case OP_CLEANUP:
                            if (in != null) PushOwner.cleanup(getApplicationContext(), in.getString("origin"), in.getString("rid"), in.getString("rev"));
                            out.putBoolean("ok", true);
                            break;
                        case OP_REFRESH:
                            PushOwner.uploadToken(getApplicationContext());
                            out.putBoolean("ok", true);
                            break;
                        default:
                            out.putBoolean("ok", false);
                    }
                } catch (RuntimeException e) {
                    out = new Bundle();
                    out.putBoolean("ok", false);
                }
                Message reply = Message.obtain(null, op);
                reply.setData(out);
                try {
                    to.send(reply);
                } catch (Exception ignored) {
                    // The caller went away.
                }
            });
        }
    });

    @Override
    public IBinder onBind(Intent intent) {
        return messenger.getBinder();
    }

    @Override
    public void onDestroy() {
        work.shutdown();
        super.onDestroy();
    }
}
