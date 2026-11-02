package nl.mvlos.experiment;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import java.io.ByteArrayInputStream;
import java.util.Collections;

/**
 * Cloud mode: the saved server's desktop inside the app, full screen, in a plain WebView of its own
 * (process ":cloud", its own data directory: MvlosApplication). Not Capacitor: the page gets no
 * native bridge, no JavaScript interface, no file access. Only the server's exact origin loads here
 * (CloudPolicy). Signing in goes through the system browser and comes back as a one-time code
 * (CloudLogin, AuthReturnActivity); GitHub's and Google's pages never load in this WebView.
 */
public class CloudActivity extends AppCompatActivity {
    static final String ACTION_RETURN = "nl.mvlos.experiment.cloud.RETURN";
    /** The server to open, from the launcher (this activity is not exported, so only the app sets it). */
    static final String EXTRA_ORIGIN = "origin";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_ERROR = "error";
    static final String EXTRA_REASON = "reason";

    /** The live cloud desktop, so a reset can close it before deleting its data (same process). */
    private static java.lang.ref.WeakReference<CloudActivity> live = new java.lang.ref.WeakReference<>(null);

    /** Closes the cloud desktop if it is open (CloudResetActivity). */
    static void closeLive() {
        CloudActivity a = live.get();
        if (a != null && !a.isFinishing()) {
            if (a.web != null) a.web.stopLoading();
            a.finish();
        }
    }

    private WebView web;
    private View progress;
    private View errorView;
    private TextView errorBody;
    private String origin;
    private ValueCallback<Uri[]> fileCallback;
    /** Set when a sign-in or a server switch loads: the pages before it leave the Back history. */
    private boolean freshStart;
    private ActivityResultLauncher<Intent> filePicker;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // The launcher's choice comes with the intent: this process keeps its own copy of the
        // preferences, which may not have seen the launcher's latest write yet.
        // The server comes with the intent (from the launcher, or from AuthReturnActivity after the
        // process was gone): this process never reads the launcher's preferences, which belong to
        // the main process and may be stale here.
        origin = checkedOrigin(state != null ? state.getString(EXTRA_ORIGIN) : getIntent().getStringExtra(EXTRA_ORIGIN));
        if (origin == null) {
            LauncherActivity.showChooser(this);
            return;
        }
        live = new java.lang.ref.WeakReference<>(this);
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_cloud);
        Immersive.enter(this);
        Immersive.webViewInsets(this, findViewById(R.id.cloud_root));
        web = findViewById(R.id.cloud_web);
        progress = findViewById(R.id.cloud_progress);
        errorView = findViewById(R.id.cloud_error);
        errorBody = findViewById(R.id.cloud_error_body);
        Button retry = findViewById(R.id.cloud_retry);
        Button choose = findViewById(R.id.cloud_choose);
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            web.loadUrl(origin + "/");
        });
        choose.setOnClickListener(v -> LauncherActivity.showChooser(this));

        filePicker = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileCallback == null) return;
            fileCallback.onReceiveValue(safePicks(WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData())));
            fileCallback = null;
        });

        WebView.setWebContentsDebuggingEnabled(BuildConfig.MVLOS_TEST);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // Lets the site show app hints (Settings → Account); it grants nothing.
        s.setUserAgentString(s.getUserAgentString() + " MvLOSApp/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, disposition, mime, length) ->
            Toast.makeText(this, R.string.cloud_no_downloads, Toast.LENGTH_LONG).show());

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (errorView.getVisibility() != View.VISIBLE && web.canGoBack()) web.goBack();
                else LauncherActivity.showChooser(CloudActivity.this);
            }
        });

        if (state != null) web.restoreState(state);
        if (state == null || web.getUrl() == null) web.loadUrl(origin + "/");
        handleReturn(getIntent());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Back from a dialog, the keyboard or the sign-in browser: full screen again.
        if (hasFocus) Immersive.enter(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String next = checkedOrigin(intent.getStringExtra(EXTRA_ORIGIN));
        if (next != null && !next.equals(origin)) {
            origin = next;
            authOp++;
            freshStart = true;
            web.loadUrl(origin + "/");
        }
        handleReturn(intent);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString(EXTRA_ORIGIN, origin);
        if (web != null) web.saveState(out);
    }

    private static String checkedOrigin(String raw) {
        if (raw == null) return null;
        ServerUrl.Result r = ServerUrl.normalize(raw);
        return r.ok() ? r.origin : null;
    }

    @Override
    protected void onDestroy() {
        authOp++;
        if (web != null) {
            web.stopLoading();
            web.destroy();
        }
        super.onDestroy();
    }

    // ---- Sign-in through the system browser ----

    /**
     * The sign-in under way (browser or native): each new attempt, a cancel, a server change or the
     * end of this screen moves it on, and every step checks it still holds, so a late answer never
     * replaces a newer sign-in.
     */
    private int authOp;

    /** Session cookies are being put in: no other sign-in starts until that has settled. */
    private boolean installing;

    private void startLogin(String provider) {
        if (installing) return;
        final int op = ++authOp;
        final String server = origin;
        new Thread(() -> {
            CloudLogin.Info info = CloudLogin.support(server, provider);
            CloudLogin.Support support = info.support;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || op != authOp || !server.equals(origin)) return;
                switch (support) {
                    case SUPPORTED:
                        if ("google".equals(provider) && info.nativeGoogleClientId != null && NativeGoogle.allowedOrigin(server)) {
                            askNativeGoogle(op, server, info.nativeGoogleClientId);
                        } else {
                            openBrowser(CloudLogin.begin(this, server, provider));
                        }
                        break;
                    case OLD_SERVER:
                        message(R.string.login_old_server_title, getString(R.string.login_old_server_body, origin));
                        break;
                    case PROVIDER_OFF:
                        message(R.string.login_provider_off_title, getString(R.string.login_provider_off_body));
                        break;
                    case NOT_CONFIGURED:
                        message(R.string.login_old_server_title, getString(R.string.login_not_configured, origin));
                        break;
                    case SERVER_ERROR:
                        message(R.string.login_unreachable_title, getString(R.string.login_server_error, origin));
                        break;
                    default:
                        message(R.string.login_unreachable_title, getString(R.string.login_unreachable_body, origin));
                }
            });
        }).start();
    }

    // ---- Native Google sign-in (Android's account picker) ----

    /**
     * Asks first, naming the server: the Google sheet itself only shows the Google project's name.
     * Choosing an account is the deliberate step; the browser stays one tap away.
     */
    private void askNativeGoogle(int op, String server, String clientId) {
        // This replaces any browser sign-in still waiting: its return no longer counts.
        CloudLogin.clear(this);
        new AlertDialog.Builder(this)
            .setTitle(R.string.native_google_title)
            .setMessage(getString(R.string.native_google_body, server))
            .setPositiveButton(R.string.native_google_choose, (d, w) -> nativeGoogle(op, server, clientId))
            .setNeutralButton(R.string.native_google_browser, (d, w) -> {
                if (op == authOp && server.equals(origin)) openBrowser(CloudLogin.begin(this, server, "google"));
            })
            .setNegativeButton(android.R.string.cancel, (d, w) -> authOp++)
            .setOnCancelListener(d -> authOp++)
            .show();
    }

    private boolean current(int op, String server) {
        return !isFinishing() && !isDestroyed() && op == authOp && server.equals(origin);
    }

    private void nativeGoogle(int op, String server, String clientId) {
        progress.setVisibility(View.VISIBLE);
        new Thread(() -> {
            String challenge = NativeGoogle.start(server);
            runOnUiThread(() -> {
                if (!current(op, server)) return;
                if (challenge == null) {
                    progress.setVisibility(View.GONE);
                    offerBrowser(op, server, getString(R.string.native_google_failed));
                    return;
                }
                // The account chooser every time (no automatic choice), with every Google account on
                // the phone and "add account". The nonce binds the token to this server.
                androidx.credentials.GetCredentialRequest request = new androidx.credentials.GetCredentialRequest.Builder()
                    .addCredentialOption(new com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption.Builder(clientId)
                        .setNonce(NativeGoogle.nonce(challenge, server)).build())
                    .build();
                androidx.credentials.CredentialManager.create(this).getCredentialAsync(this, request, new android.os.CancellationSignal(),
                    androidx.core.content.ContextCompat.getMainExecutor(this),
                    new androidx.credentials.CredentialManagerCallback<androidx.credentials.GetCredentialResponse, androidx.credentials.exceptions.GetCredentialException>() {
                        @Override
                        public void onResult(androidx.credentials.GetCredentialResponse result) {
                            if (!current(op, server)) return;
                            String idToken = googleIdToken(result.getCredential());
                            if (idToken == null) {
                                progress.setVisibility(View.GONE);
                                offerBrowser(op, server, getString(R.string.native_google_failed));
                                return;
                            }
                            redeemNative(op, server, challenge, idToken);
                        }

                        @Override
                        public void onError(androidx.credentials.exceptions.GetCredentialException e) {
                            progress.setVisibility(View.GONE);
                            if (!current(op, server)) return;
                            // Cancelled: the person said no; nothing else opens by itself.
                            if (e instanceof androidx.credentials.exceptions.GetCredentialCancellationException) {
                                authOp++;
                                return;
                            }
                            offerBrowser(op, server, getString(e instanceof androidx.credentials.exceptions.NoCredentialException
                                ? R.string.native_google_no_account : R.string.native_google_failed));
                        }
                    });
            });
        }).start();
    }

    /** The Google ID token from Credential Manager's answer, or null if it is anything else. */
    private static String googleIdToken(androidx.credentials.Credential credential) {
        if (!(credential instanceof androidx.credentials.CustomCredential)) return null;
        androidx.credentials.CustomCredential custom = (androidx.credentials.CustomCredential) credential;
        if (!com.google.android.libraries.identity.googleid.GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(custom.getType())) return null;
        try {
            return com.google.android.libraries.identity.googleid.GoogleIdTokenCredential.createFrom(custom.getData()).getIdToken();
        } catch (Exception e) {
            // GoogleIdTokenParsingException is a checked exception (thrown from Kotlin): anything unreadable means no token.
            return null;
        }
    }

    private void redeemNative(int op, String server, String challenge, String idToken) {
        final String oldCookie = CookieManager.getInstance().getCookie(server + "/");
        new Thread(() -> {
            NativeGoogle.Result r = NativeGoogle.redeem(server, challenge, idToken, oldCookie);
            runOnUiThread(() -> {
                if (!current(op, server)) return;
                if (r.cookies == null) {
                    progress.setVisibility(View.GONE);
                    // The server's own refusals (banned, sign-up closed or full) are final; other failures can try the browser.
                    if ("banned".equals(r.error) || "closed".equals(r.error) || "full".equals(r.error)) {
                        message(R.string.login_failed_title, errorText(r.error, r.reason));
                    } else {
                        offerBrowser(op, server, getString(R.string.native_google_failed));
                    }
                    return;
                }
                install(server, r.cookies, 0, op);
            });
        }).start();
    }

    /** Native sign-in didn't work: say so, and offer the browser as an explicit choice. */
    private void offerBrowser(int op, String server, String why) {
        new AlertDialog.Builder(this)
            .setTitle(R.string.login_failed_title)
            .setMessage(why)
            .setPositiveButton(R.string.native_google_browser, (d, w) -> {
                if (op == authOp && server.equals(origin)) openBrowser(CloudLogin.begin(this, server, "google"));
            })
            .setNegativeButton(android.R.string.cancel, (d, w) -> authOp++)
            .show();
    }

    /** The provider's sign-in, in the system browser (a Custom Tab where available): never in this WebView. */
    private void openBrowser(String url) {
        Uri uri = Uri.parse(url);
        String browser = CustomTabsClient.getPackageName(this, null);
        try {
            if (browser != null) {
                CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).build();
                tab.intent.setPackage(browser);
                tab.launchUrl(this, uri);
            } else {
                startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
            }
        } catch (ActivityNotFoundException e) {
            CloudLogin.clear(this);
            message(R.string.no_browser_title, getString(R.string.login_no_browser));
        }
    }

    /** Back from the browser (AuthReturnActivity checked the state): redeem the code, or say why not. */
    private void handleReturn(Intent intent) {
        if (intent == null || !ACTION_RETURN.equals(intent.getAction())) return;
        setIntent(new Intent());
        CloudLogin.Pending pending = CloudLogin.take(this);
        String state = intent.getStringExtra(EXTRA_STATE);
        if (pending == null || !CloudLogin.same(state, pending.state) || !pending.origin.equals(origin)) {
            message(R.string.login_failed_title, getString(R.string.login_expired));
            return;
        }
        String error = intent.getStringExtra(EXTRA_ERROR);
        if (error != null) {
            message(R.string.login_failed_title, errorText(error, intent.getStringExtra(EXTRA_REASON)));
            return;
        }
        String code = intent.getStringExtra(EXTRA_CODE);
        if (code == null || !code.matches("[A-Za-z0-9_-]{43}")) {
            message(R.string.login_failed_title, getString(R.string.login_expired));
            return;
        }
        // The app redeems it itself (not the WebView), then puts the checked session cookies into
        // the WebView and loads the desktop.
        final String server = origin;
        // The return is a sign-in of its own now: anything older no longer lands.
        final int op = ++authOp;
        final String verifier = pending.verifier;
        final String oldCookie = CookieManager.getInstance().getCookie(server + "/");
        progress.setVisibility(View.VISIBLE);
        new Thread(() -> {
            java.util.List<String> cookies = CloudLogin.redeem(server, code, verifier, oldCookie);
            runOnUiThread(() -> {
                // Nothing late lands: the desktop closed or moved to another server meanwhile.
                if (isFinishing() || isDestroyed() || !server.equals(origin)) return;
                if (cookies == null) {
                    progress.setVisibility(View.GONE);
                    message(R.string.login_failed_title, getString(R.string.login_error));
                    return;
                }
                install(server, cookies, 0, op);
            });
        }).start();
    }

    /** Puts the cookies in one by one (each confirmed), then opens the signed-in desktop. */
    private void install(String server, java.util.List<String> cookies, int i, int op) {
        installing = true;
        if (!current(op, server)) {
            // Cancelled or replaced while the cookies went in: the ones already written go again.
            undoInstall(server, cookies, i);
            return;
        }
        if (i == cookies.size()) {
            installing = false;
            CookieManager.getInstance().flush();
            errorView.setVisibility(View.GONE);
            freshStart = true;
            web.loadUrl(server + "/?auth=ok");
            return;
        }
        CookieManager.getInstance().setCookie(server, cookies.get(i), ok -> {
            if (ok) {
                install(server, cookies, i + 1, op);
                return;
            }
            undoInstall(server, cookies, i);
            if (current(op, server)) message(R.string.login_failed_title, getString(R.string.login_error));
        });
    }

    /** Expires the first `count` of these cookies (MvL OS's own names, Path=/), so a sign-in that didn't finish leaves no session behind. */
    private void undoInstall(String server, java.util.List<String> cookies, int count) {
        for (int k = 0; k < count && k < cookies.size(); k++) {
            String name = cookies.get(k).substring(0, cookies.get(k).indexOf('='));
            CookieManager.getInstance().setCookie(server, name + "=; Path=/; Max-Age=0; Secure");
        }
        CookieManager.getInstance().flush();
        installing = false;
        progress.setVisibility(View.GONE);
    }

    private String errorText(String error, String reason) {
        switch (error) {
            case "closed": return getString(R.string.login_closed);
            case "full": return getString(R.string.login_full);
            case "banned": return reason != null && !reason.isEmpty() ? getString(R.string.login_banned_reason, reason.length() > 200 ? reason.substring(0, 200) : reason) : getString(R.string.login_banned);
            case "denied": return getString(R.string.login_denied);
            case "off": return getString(R.string.login_provider_off_body);
            default: return getString(R.string.login_error);
        }
    }

    private void message(int title, String body) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(body).setPositiveButton(android.R.string.ok, null).show();
    }

    private void showError(String body) {
        errorBody.setText(body);
        errorView.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
    }

    /**
     * What a file picker returned, keeping only documents of other apps. A picker is another app and
     * its answer is untrusted: a file:// path, or a content:// address of this app's own providers,
     * would let it hand the page this app's private files (cookies, the sign-in in progress, the
     * on-device desktop's data), which the WebView would read with this app's rights.
     */
    private Uri[] safePicks(Uri[] picked) {
        if (picked == null) return null;
        java.util.List<Uri> ok = new java.util.ArrayList<>();
        for (Uri u : picked) {
            if (u == null || !"content".equals(u.getScheme()) || u.getAuthority() == null) continue;
            android.content.pm.ProviderInfo provider = getPackageManager().resolveContentProvider(u.getAuthority(), 0);
            if (provider == null || getPackageName().equals(provider.packageName)) continue;
            ok.add(u);
        }
        return ok.isEmpty() ? null : ok.toArray(new Uri[0]);
    }

    private static WebResourceResponse refused() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Frames may show other sites, but never GitHub's or Google's sign-in, also after a redirect.
            if (!request.isForMainFrame()) return CloudPolicy.classify(origin, request.getUrl().toString()) == CloudPolicy.Action.PROVIDER_PAGE;
            String url = request.getUrl().toString();
            switch (CloudPolicy.classify(origin, url)) {
                case STAY:
                    return false;
                case LOGIN_GITHUB:
                    startLogin("github");
                    return true;
                case LOGIN_GOOGLE:
                    startLogin("google");
                    return true;
                case CHOOSER:
                    if (request.hasGesture()) LauncherActivity.showChooser(CloudActivity.this);
                    return true;
                case PROVIDER_PAGE:
                    message(R.string.provider_page_title, getString(R.string.provider_page_body, origin));
                    return true;
                case EXTERNAL:
                    if (request.hasGesture()) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE));
                        } catch (ActivityNotFoundException ignored) {
                            // Nothing handles it: stay on the desktop.
                        }
                    }
                    return true;
                default:
                    return true;
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // shouldOverrideUrlLoading is not asked about POST navigations: anything but the
            // server's own pages is refused here too, whatever the method.
            CloudPolicy.Action action = CloudPolicy.classify(origin, request.getUrl().toString());
            if (request.isForMainFrame() && action != CloudPolicy.Action.STAY) return refused();
            // GitHub's and Google's sign-in pages never load here, not even in a frame.
            if (action == CloudPolicy.Action.PROVIDER_PAGE) return refused();
            return null;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            // A backstop for what the checks above don't see (a POST answered with a redirect
            // elsewhere): a page of another origin never stays in this WebView.
            if (url != null && CloudPolicy.classify(origin, url) != CloudPolicy.Action.STAY) {
                view.stopLoading();
                if (view.canGoBack()) view.goBack();
                else view.loadUrl(origin + "/");
                return;
            }
            progress.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progress.setVisibility(View.GONE);
            if (freshStart && url != null) {
                freshStart = false;
                view.clearHistory();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && CloudPolicy.classify(origin, request.getUrl().toString()) == CloudPolicy.Action.STAY) {
                showError(getString(R.string.cloud_error_body, origin));
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            showError(getString(R.string.cloud_ssl_error, origin));
        }

        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            // The page's renderer died: start again rather than taking the app down.
            recreate();
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                // The system's document picker (Android's own, not any app that claims to pick files).
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = params.getAcceptTypes();
                java.util.List<String> mimes = new java.util.ArrayList<>();
                if (types != null) for (String t : types) if (t != null && t.matches("[a-z]+/[a-z0-9.+*-]+")) mimes.add(t);
                if (!mimes.isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                filePicker.launch(pick);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            // Camera, microphone and the like are not offered to the page.
            request.deny();
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String o, GeolocationPermissions.Callback callback) {
            callback.invoke(o, false, false);
        }
    }
}
