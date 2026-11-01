package nl.mvlos.experiment;

import android.os.Bundle;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.webkit.WebView;
import android.webkit.WebResourceRequest;
import com.getcapacitor.BridgeWebViewClient;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * Local mode: the bundled guest desktop at https://localhost. The native bridge never loads a
 * remote origin. Started by LauncherActivity (not exported); Back at the root returns there.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle state) {
        registerPlugin(MvlosAppPlugin.class);
        super.onCreate(state);
        if (getBridge() == null) return;
        getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Never load remote documents or data/blob documents with the native bridge.
                var url = request.getUrl();
                if ("https".equals(url.getScheme()) && "localhost".equals(url.getHost())
                    && url.getPort() == -1) {
                    return super.shouldOverrideUrlLoading(view, request);
                }
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
