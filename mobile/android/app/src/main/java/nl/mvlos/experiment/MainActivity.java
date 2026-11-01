package nl.mvlos.experiment;

import android.os.Bundle;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import com.getcapacitor.BridgeWebViewClient;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * Local mode: the bundled guest desktop at https://localhost. The native bridge never loads a
 * remote origin. Started by LauncherActivity (not exported); Back at the root returns there.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) Immersive.enter(this);
    }

    private static boolean isApp(Uri url) {
        return "https".equals(url.getScheme()) && "localhost".equals(url.getHost()) && url.getPort() == -1;
    }

    /**
     * Capacitor's local server also serves files of the app (/_capacitor_file_/<path>) and content
     * URIs (/_capacitor_content_/...) to the page. The bundled desktop uses neither, so they are
     * refused, for the page and for service workers alike.
     */
    private static boolean isNativeFileUrl(Uri url) {
        for (String p : new String[] { url.getPath(), url.getEncodedPath() }) {
            if (p == null) continue;
            String lower = p.toLowerCase(java.util.Locale.ROOT);
            if (lower.contains("capacitor_file") || lower.contains("capacitor_content")) return true;
        }
        return false;
    }

    private static WebResourceResponse refused() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @Override
    public void onCreate(Bundle state) {
        registerPlugin(MvlosAppPlugin.class);
        registerPlugin(DisabledCorePlugins.Http.class);
        registerPlugin(DisabledCorePlugins.Cookies.class);
        registerPlugin(DisabledCorePlugins.ServerPath.class);
        super.onCreate(state);
        if (getBridge() == null) return;
        // Full screen; Capacitor's SystemBars (insetsHandling "native") hands the cutout to the
        // page's env(safe-area-inset-*) and pads only the keyboard.
        Immersive.enter(this);
        // Without WebMessageListener, Capacitor falls back to a JavaScript interface that every frame
        // can reach, so remote frames are refused as well as remote pages.
        boolean framesSafe = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // shouldOverrideUrlLoading below is not asked for POST navigations (a submitted
                // form), so remote documents are refused here as well, whatever the method.
                Uri url = request.getUrl();
                if (!isApp(url) && (request.isForMainFrame() || !framesSafe)) return refused();
                if (isApp(url) && isNativeFileUrl(url)) return refused();
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Never load remote documents or data/blob documents with the native bridge.
                var url = request.getUrl();
                if (isApp(url)) return super.shouldOverrideUrlLoading(view, request);
                if (request.isForMainFrame() && request.hasGesture()
                    && "https".equals(url.getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (ActivityNotFoundException ignored) {
                        // A device without a browser leaves the guest desktop in place.
                    }
                }
                return true;
            }
        });
        // Replaces the service worker client Capacitor set up, with the same file refusal.
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isApp(url) && isNativeFileUrl(url)) return refused();
                return getBridge().getLocalServer().shouldInterceptRequest(request);
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge().getWebView().canGoBack()) {
                    getBridge().getWebView().goBack();
                } else {
                    LauncherActivity.showChooser(MainActivity.this);
                }
            }
        });
    }
}
