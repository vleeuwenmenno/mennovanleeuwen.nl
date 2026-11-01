package nl.mvlos.experiment;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;
import androidx.webkit.WebStorageCompat;
import androidx.webkit.WebViewFeature;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Disconnecting from a cloud server, or switching to another: runs in the cloud process (its own
 * WebView data, MvlosApplication). Signs the app's session out on the server (best effort: the
 * server may be unreachable), then deletes everything the cloud WebView kept: cookies, web storage
 * (localStorage, IndexedDB, service workers, caches), the HTTP cache, and any sign-in in progress.
 * The on-device desktop's data and the user's browser are not touched. Not exported.
 */
public class CloudResetActivity extends Activity {
    static final String EXTRA_ORIGIN = "origin";
    /** Result extra: whether the server confirmed the sign-out. */
    static final String EXTRA_SIGNED_OUT = "signedOut";
    /** Result extra: whether the app had a session with that server. */
    static final String EXTRA_HAD_SESSION = "hadSession";
    private volatile boolean signedOut;
    private boolean hadSession;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String raw = getIntent().getStringExtra(EXTRA_ORIGIN);
        ServerUrl.Result checked = raw == null ? null : ServerUrl.normalize(raw);
        String origin = checked != null && checked.ok() ? checked.origin : null;
        // Nothing may write to the cloud WebView's data while it is deleted.
        CloudActivity.closeLive();
        CloudLogin.clear(this);
        CookieManager cookies = CookieManager.getInstance();
        String cookie = origin == null ? null : cookies.getCookie(origin + "/");
        hadSession = cookie != null && cookie.contains("mvlos_sid=");
        new Thread(() -> {
            signedOut = origin != null && cookie != null && signOut(origin, cookie);
            runOnUiThread(this::wipe);
        }).start();
    }

    private static boolean signOut(String origin, String cookie) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(origin + "/api/auth/logout").openConnection();
            c.setRequestMethod("POST");
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            c.setRequestProperty("Cookie", cookie);
            c.setRequestProperty("Origin", origin);
            c.setDoOutput(true);
            c.getOutputStream().close();
            return c.getResponseCode() == 200;
        } catch (Exception ignored) {
            // Unreachable: the session stays on the server until it expires; the app forgets it anyway.
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void wipe() {
        CloudLogin.clear(this);
        WebView scratch = new WebView(this);
        scratch.clearCache(true);
        scratch.destroy();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
            // Everything the cloud WebView keeps: cookies, HTTP cache, and all of JavaScript's
            // storage (localStorage, IndexedDB, service workers, Cache Storage).
            WebStorageCompat.deleteBrowsingData(WebStorage.getInstance(), this::cookiesThenDone);
        } else {
            WebStorage.getInstance().deleteAllData();
            cookiesThenDone();
        }
    }

    private void cookiesThenDone() {
        CookieManager.getInstance().removeAllCookies(done -> {
            CookieManager.getInstance().flush();
            setResult(RESULT_OK, new android.content.Intent().putExtra(EXTRA_SIGNED_OUT, signedOut).putExtra(EXTRA_HAD_SESSION, hadSession));
            finish();
        });
    }
}
