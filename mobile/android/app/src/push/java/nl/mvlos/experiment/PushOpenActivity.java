package nl.mvlos.experiment;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * What tapping a notification starts (main process, not exported). It checks that the notification
 * still belongs to the current registration and re-validates the address, then hands over to
 * CloudActivity with the saved ORIGIN from the push state (never one from the intent) and the
 * canonical path. Anything else just closes.
 */
public class PushOpenActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent in = getIntent();
        try {
            String rid = in.getStringExtra("rid");
            long gen = in.getLongExtra("gen", -1);
            String path = PushDeepLink.validate(in.getStringExtra("path"));
            PushState state2 = PushStore.get(this);
            PushState.Snapshot s = state2.snapshot();
            if (rid != null && path != null && state2.isCurrent(gen, rid) && PushOrigins.allowed(BuildConfig.PUSH_ORIGINS, s.origin)) {
                startActivity(new Intent(this, CloudActivity.class).putExtra(CloudActivity.EXTRA_ORIGIN, s.origin).putExtra(CloudActivity.EXTRA_PUSH_PATH, path));
            }
        } catch (RuntimeException ignored) {
            // Nothing opens on anything unreadable.
        }
        finish();
    }
}
