package nl.mvlos.experiment;

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
public class CloudResetActivity extends androidx.activity.ComponentActivity {
    static final String EXTRA_ORIGIN = "origin";
    /** Result extra: whether the server confirmed the sign-out. */
    static final String EXTRA_SIGNED_OUT = "signedOut";
    /**
     * Result extra: this WebView can't delete everything itself (no DELETE_BROWSING_DATA), so the
     * cloud process ends and the launcher deletes the cloud WebView's directories (deleteCloudData).
     */
    static final String EXTRA_WIPE_DIRS = "wipeDirs";
    /** Result extra: whether the app had a session with that server. */
    static final String EXTRA_HAD_SESSION = "hadSession";
    private volatile boolean signedOut;
    private boolean hadSession;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setFinishOnTouchOutside(false);
        // Not cancellable: a half-done reset must never count as done. Through the dispatcher, so
        // it holds with predictive Back too (Android 16 no longer calls onBackPressed).
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Ignored until the reset finishes.
            }
        });
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
            // deleteAllData leaves service workers and Cache Storage: the whole profile goes instead.
            WebStorage.getInstance().deleteAllData();
            wipeDirs = true;
            cookiesThenDone();
        }
    }

    private boolean wipeDirs;

    private void cookiesThenDone() {
        CookieManager.getInstance().removeAllCookies(done -> {
            CookieManager.getInstance().flush();
            setResult(RESULT_OK, new android.content.Intent().putExtra(EXTRA_SIGNED_OUT, signedOut)
                .putExtra(EXTRA_HAD_SESSION, hadSession).putExtra(EXTRA_WIPE_DIRS, wipeDirs));
            finish();
            // The profile's files can only be deleted once nothing in this process holds them.
            if (wipeDirs) new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> android.os.Process.killProcess(android.os.Process.myPid()), 300);
        });
    }

    /**
     * From the main process, once the cloud process has ended: deletes the cloud WebView's whole
     * profile (app_webview_cloud and its cache). Returns whether it could.
     */
    static boolean deleteCloudData(android.content.Context context) {
        android.app.ActivityManager am = (android.app.ActivityManager) context.getSystemService(ACTIVITY_SERVICE);
        String cloud = context.getPackageName() + MvlosApplication.CLOUD_PROCESS_SUFFIX;
        for (int i = 0; i < 40; i++) {
            boolean running = false;
            java.util.List<android.app.ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
            if (procs != null) for (android.app.ActivityManager.RunningAppProcessInfo p : procs) running |= cloud.equals(p.processName);
            if (!running) {
                java.io.File data = new java.io.File(context.getApplicationInfo().dataDir);
                return delete(new java.io.File(data, "app_webview_cloud")) & delete(new java.io.File(context.getCacheDir(), "webview_cloud"));
            }
            try {
                Thread.sleep(100);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return false;
    }

    private static boolean delete(java.io.File f) {
        if (!f.exists()) return true;
        java.io.File[] children = f.isDirectory() ? f.listFiles() : null;
        boolean ok = true;
        if (children != null) for (java.io.File c : children) ok &= delete(c);
        return f.delete() && ok;
    }
}
