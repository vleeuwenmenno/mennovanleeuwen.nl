package nl.mvlos.experiment;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONObject;

/**
 * The app's own, authoritative opt-in for push notifications (cloud process: it holds the
 * session). The page can only open it with a tap on exactly mvlosapp://push; everything shown
 * and decided here comes from the app and the server, never from the page. Steps: prepare (inert,
 * names the account) -> the user confirms -> Android's notification permission -> activate (a
 * compare-and-swap on the server) -> hand the credentials to the owner. The session and account
 * are checked again after every wait; any doubt ends it with nothing enabled.
 */
public class PushOptInActivity extends AppCompatActivity {
    private String origin;
    private String cookie;
    private String uid;
    private String prep;
    /** The push generation the opt-in started under: enrolling is refused if anything revoked or enrolled since. */
    private long generation;
    private ActivityResultLauncher<String> permission;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        permission = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> afterPermission());
        String raw = getIntent().getStringExtra(CloudActivity.EXTRA_ORIGIN);
        ServerUrl.Result checked = raw == null ? null : ServerUrl.normalize(raw);
        origin = checked != null && checked.ok() && PushOrigins.allowed(BuildConfig.PUSH_ORIGINS, checked.origin) ? checked.origin : null;
        if (origin == null) {
            end(R.string.push_unavailable);
            return;
        }
        cookie = CookieManager.getInstance().getCookie(origin + "/");
        uid = PushController.cookieValue(cookie, "mvlos_uid");
        if (uid == null || PushController.cookieValue(cookie, "mvlos_sid") == null) {
            end(R.string.push_need_signin);
            return;
        }
        final String session = cookie;
        new Thread(() -> {
            Bundle st = PushOwnerClient.call(this, PushOwnerService.OP_STATUS, null, 5000);
            if (st == null) {
                runOnUiThread(() -> end(R.string.push_failed));
                return;
            }
            try {
                JSONObject body = new JSONObject().put("installId", st.getString("install")).put("device", Build.MODEL);
                PushApi.Result r = PushApi.sessionPost(origin, "/api/push/native/prepare", session, uid, body);
                if (!r.ok() || r.body == null) {
                    runOnUiThread(() -> end(r.status == 503 ? R.string.push_server_off : R.string.push_failed));
                    return;
                }
                generation = st.getLong("gen", -1);
                prep = r.body.getString("prep");
                final String login = r.body.getString("login");
                runOnUiThread(() -> confirm(login));
            } catch (Exception e) {
                runOnUiThread(() -> end(R.string.push_failed));
            }
        }).start();
    }

    private void confirm(String login) {
        new AlertDialog.Builder(this)
            .setTitle(R.string.push_title)
            .setMessage(getString(R.string.push_body, origin, login))
            .setCancelable(false)
            .setPositiveButton(R.string.push_allow, (d, w) -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.POST_NOTIFICATIONS);
                else afterPermission();
            })
            .setNegativeButton(android.R.string.cancel, (d, w) -> finish())
            .show();
    }

    private void afterPermission() {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            end(R.string.push_blocked);
            return;
        }
        // The same session and account as when it was confirmed, or nothing happens.
        String now = CookieManager.getInstance().getCookie(origin + "/");
        if (!uid.equals(PushController.cookieValue(now, "mvlos_uid")) || !PushController.cookieValue(cookie, "mvlos_sid").equals(PushController.cookieValue(now, "mvlos_sid"))) {
            end(R.string.push_failed);
            return;
        }
        final String session = now;
        new Thread(() -> {
            try {
                PushApi.Result r = PushApi.sessionPost(origin, "/api/push/native/activate", session, uid, new JSONObject().put("prep", prep));
                if (!r.ok() || r.body == null) {
                    runOnUiThread(() -> end(R.string.push_failed));
                    return;
                }
                String rid = r.body.getString("rid");
                String cap = r.body.getString("cap");
                String rev = r.body.getString("rev");
                // The activation may have been slow: the same session and account, or the registration is dropped again.
                String after = CookieManager.getInstance().getCookie(origin + "/");
                if (!uid.equals(PushController.cookieValue(after, "mvlos_uid")) || !PushController.cookieValue(cookie, "mvlos_sid").equals(PushController.cookieValue(after, "mvlos_sid"))) {
                    cleanup(rid, rev);
                    runOnUiThread(() -> end(R.string.push_failed));
                    return;
                }
                Bundle b = new Bundle();
                b.putLong("gen", generation);
                b.putString("origin", origin);
                b.putString("uid", uid);
                b.putString("rid", rid);
                b.putString("cap", cap);
                b.putString("rev", rev);
                Bundle ack = PushOwnerClient.call(this, PushOwnerService.OP_ENROLL, b, 8000);
                boolean ok = ack != null && ack.getBoolean("ok");
                // The owner could not keep it: the registration must not stay on the server.
                if (!ok) cleanup(rid, rev);
                final boolean done = ok;
                runOnUiThread(() -> end(done ? R.string.push_done : R.string.push_failed));
            } catch (Exception e) {
                runOnUiThread(() -> end(R.string.push_failed));
            }
        }).start();
    }

    /** The registration cannot be kept: the owner stores its revocation credential and deletes it on the server when the network allows. */
    private void cleanup(String rid, String rev) {
        Bundle b = new Bundle();
        b.putString("origin", origin);
        b.putString("rid", rid);
        b.putString("rev", rev);
        PushOwnerClient.call(this, PushOwnerService.OP_CLEANUP, b, 5000);
    }

    private void end(int message) {
        new AlertDialog.Builder(this).setMessage(message).setCancelable(false).setPositiveButton(android.R.string.ok, (d, w) -> finish()).show();
    }
}
