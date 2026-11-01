package nl.mvlos.experiment;

import android.os.Bundle;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.net.Uri;
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
    private static boolean isApp(Uri url) {
        return "https".equals(url.getScheme()) && "localhost".equals(url.getHost()) && url.getPort() == -1;
    }

    @Override
    public void onCreate(Bundle state) {
        registerPlugin(MvlosAppPlugin.class);
        registerPlugin(DisabledCorePlugins.Http.class);
        registerPlugin(DisabledCorePlugins.Cookies.class);
        registerPlugin(DisabledCorePlugins.ServerPath.class);
        super.onCreate(state);
        if (getBridge() == null) return;
        // Without WebMessageListener, Capacitor falls back to a JavaScript interface that every frame
        // can reach, so remote frames are refused as well as remote pages.
        boolean framesSafe = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER);
        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // shouldOverrideUrlLoading below is not asked for POST navigations (a submitted
                // form), so remote documents are refused here as well, whatever the method.
                if (!isApp(request.getUrl()) && (request.isForMainFrame() || !framesSafe)) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
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
