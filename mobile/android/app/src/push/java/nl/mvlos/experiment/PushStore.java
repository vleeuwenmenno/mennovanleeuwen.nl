package nl.mvlos.experiment;

import android.content.Context;
import android.content.SharedPreferences;
import java.security.SecureRandom;
import java.util.Map;
import java.util.Set;

/** The one PushState of this app, in the MAIN process only (see PushState). */
final class PushStore {
    private static PushState state;

    private PushStore() {}

    private static final class Prefs implements PushState.Store {
        private final SharedPreferences prefs;

        Prefs(Context c) {
            prefs = c.getApplicationContext().getSharedPreferences("mvlos_push", Context.MODE_PRIVATE);
        }

        @Override
        public String get(String key) {
            return prefs.getString(key, null);
        }

        @Override
        public void commit(Map<String, String> puts, Set<String> removes) {
            SharedPreferences.Editor e = prefs.edit();
            for (String k : removes) e.remove(k);
            for (Map.Entry<String, String> p : puts.entrySet()) e.putString(p.getKey(), p.getValue());
            if (!e.commit()) throw new IllegalStateException("could not save");
        }
    }

    static synchronized PushState get(Context c) {
        if (state == null) {
            state = new PushState(new Prefs(c), new KeystoreBox(), System::currentTimeMillis, () -> {
                byte[] b = new byte[16];
                new SecureRandom().nextBytes(b);
                return android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
            });
        }
        return state;
    }

    /** True in the main process (the one that owns the state). */
    static boolean isMainProcess() {
        String name = android.app.Application.getProcessName();
        return name != null && !name.contains(":");
    }
}
