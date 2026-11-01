package nl.mvlos.experiment;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor's bridge always registers its core plugins CapacitorHttp (native HTTP outside the
 * browser's CORS), CapacitorCookies and WebView (changing where the app's files are served from).
 * The bundled desktop needs none of them. MainActivity registers these empty plugins under the
 * same names; app plugins are registered after the core ones, so they replace them and calls to
 * the core methods are refused ("not implemented"). The JavaScript interfaces the core plugins
 * add to the WebView are removed before the first page loads. SystemBars stays (insets).
 */
public final class DisabledCorePlugins {
    private DisabledCorePlugins() {}

    @CapacitorPlugin(name = "CapacitorHttp")
    public static class Http extends Plugin {
        @Override
        public void load() {
            getBridge().getWebView().removeJavascriptInterface("CapacitorHttpAndroidInterface");
        }
    }

    @CapacitorPlugin(name = "CapacitorCookies")
    public static class Cookies extends Plugin {
        @Override
        public void load() {
            getBridge().getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        }
    }

    @CapacitorPlugin(name = "WebView")
    public static class ServerPath extends Plugin {}
}
