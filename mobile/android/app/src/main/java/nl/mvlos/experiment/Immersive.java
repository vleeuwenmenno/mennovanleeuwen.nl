package nl.mvlos.experiment;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;

/**
 * Full screen for every screen of the app: the status and navigation bars are hidden (immersive)
 * and come back for a moment with a swipe from the edge; the content draws edge to edge, also
 * beside a display cutout. Call `enter` after setContentView and again when the window regains
 * focus (the system shows the bars for dialogs, the keyboard or another app such as the sign-in
 * browser). https://developer.android.com/develop/ui/views/layout/immersive
 */
final class Immersive {
    /** WebView passes window insets to CSS env(safe-area-inset-*) from this version (as Capacitor's SystemBars assumes). */
    private static final int WEBVIEW_SAFE_AREA = 140;

    private Immersive() {}

    static void enter(Activity activity) {
        Window window = activity.getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        WindowManager.LayoutParams attrs = window.getAttributes();
        if (attrs.layoutInDisplayCutoutMode != WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES) {
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        bars.hide(WindowInsetsCompat.Type.systemBars());
    }

    /** Whether this WebView turns the window's insets into env(safe-area-inset-*) for the page. */
    static boolean webViewHasSafeArea(Activity activity) {
        try {
            PackageInfo info = WebViewCompat.getCurrentWebViewPackage(activity);
            return info != null && info.versionName != null && Integer.parseInt(info.versionName.split("\\.")[0]) >= WEBVIEW_SAFE_AREA;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /**
     * Insets for a view holding a WebView page that uses env(safe-area-inset-*) (viewport-fit=cover,
     * as MvL OS does): nothing is padded but the keyboard, and the cutout (bars are hidden, so
     * that's all that's left) is handed on to the WebView, so the page keeps its controls clear
     * of a camera notch itself. Older WebViews get the cutout as padding instead.
     */
    static void webViewInsets(Activity activity, View root) {
        boolean passThrough = webViewHasSafeArea(activity);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (!passThrough) {
                v.setPadding(safe.left, safe.top, safe.right, keyboard ? Math.max(ime.bottom, safe.bottom) : safe.bottom);
                return WindowInsetsCompat.CONSUMED;
            }
            v.setPadding(0, 0, 0, keyboard ? ime.bottom : 0);
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                    Insets.of(safe.left, safe.top, safe.right, keyboard ? 0 : safe.bottom))
                .build();
        });
    }
}
