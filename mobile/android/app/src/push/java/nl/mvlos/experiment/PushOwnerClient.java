package nl.mvlos.experiment;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** The cloud process's side of PushOwnerService: one blocking call with a deadline. Never on the main thread. */
final class PushOwnerClient {
    private PushOwnerClient() {}

    /** The owner's reply, or null when it could not be reached or did not answer in time. */
    static Bundle call(Context context, int op, Bundle data, long timeoutMs) {
        if (Looper.myLooper() == Looper.getMainLooper()) return null;
        final Context app = context.getApplicationContext();
        final CountDownLatch connected = new CountDownLatch(1);
        final CountDownLatch answered = new CountDownLatch(1);
        final AtomicReference<Messenger> door = new AtomicReference<>();
        final AtomicReference<Bundle> answer = new AtomicReference<>();
        HandlerThread thread = new HandlerThread("push-owner-client");
        thread.start();
        final Messenger reply = new Messenger(new Handler(thread.getLooper()) {
            @Override
            public void handleMessage(Message m) {
                answer.set(m.getData());
                answered.countDown();
            }
        });
        ServiceConnection conn = new ServiceConnection() {
            @Override
            public void onServiceConnected(ComponentName name, IBinder service) {
                door.set(new Messenger(service));
                connected.countDown();
            }

            @Override
            public void onServiceDisconnected(ComponentName name) {}
        };
        boolean bound = false;
        try {
            bound = app.bindService(new Intent(app, PushOwnerService.class), conn, Context.BIND_AUTO_CREATE);
            if (!bound || !connected.await(timeoutMs, TimeUnit.MILLISECONDS)) return null;
            Message m = Message.obtain(null, op);
            if (data != null) m.setData(data);
            m.replyTo = reply;
            door.get().send(m);
            return answered.await(timeoutMs, TimeUnit.MILLISECONDS) ? answer.get() : null;
        } catch (Exception e) {
            return null;
        } finally {
            if (bound) app.unbindService(conn);
            thread.quitSafely();
        }
    }
}
