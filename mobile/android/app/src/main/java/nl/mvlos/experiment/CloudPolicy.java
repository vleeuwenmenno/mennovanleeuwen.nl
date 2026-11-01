package nl.mvlos.experiment;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * What the cloud desktop's WebView does with a top-level navigation. Plain Java (no Android
 * classes) so it runs in local JUnit tests.
 *
 * <p>Only the saved server's exact origin loads in the WebView. Its sign-in starts are taken over
 * by the app (the provider's pages must open in the system browser, never in the WebView), the
 * app-login start never loads there, and links elsewhere open in the browser.
 */
public final class CloudPolicy {
    public enum Action {
        /** Load it in the WebView: the server's own page. */
        STAY,
        /** Sign in with GitHub through the system browser (app login). */
        LOGIN_GITHUB,
        /** Sign in with Google through the system browser (app login). */
        LOGIN_GOOGLE,
        /** Back to the app's on-device / cloud chooser (mvlosapp://chooser). */
        CHOOSER,
        /** A provider's sign-in page (for example linking a sign-in): never inside the app. */
        PROVIDER_PAGE,
        /** Another site or app (https, mailto, tel): handed to the system, after a tap. */
        EXTERNAL,
        /** Refused. */
        BLOCK
    }

    private CloudPolicy() {}

    public static Action classify(String origin, String url) {
        if (origin == null || url == null) return Action.BLOCK;
        URI u;
        URI o;
        try {
            u = new URI(url);
            o = new URI(origin);
        } catch (URISyntaxException e) {
            return Action.BLOCK;
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("mvlosapp")) {
            return "chooser".equals(u.getHost()) || "//chooser".equals(u.getRawSchemeSpecificPart()) ? Action.CHOOSER : Action.BLOCK;
        }
        if (scheme.equals("mailto") || scheme.equals("tel")) return Action.EXTERNAL;
        if (!scheme.equals("https") || u.getHost() == null || u.getRawUserInfo() != null) return Action.BLOCK;
        String host = u.getHost().toLowerCase(Locale.ROOT);
        if (sameOrigin(o, u)) {
            String path = u.getRawPath() == null ? "" : u.getRawPath();
            if (path.equals("/api/auth/github/login")) return Action.LOGIN_GITHUB;
            if (path.equals("/api/auth/google/login")) return Action.LOGIN_GOOGLE;
            // The app-login start belongs in the system browser only.
            if (path.startsWith("/api/auth/app/start")) return Action.BLOCK;
            return Action.STAY;
        }
        if (host.equals("accounts.google.com") || host.endsWith(".accounts.google.com")) return Action.PROVIDER_PAGE;
        if ((host.equals("github.com") || host.endsWith(".github.com")) && u.getRawPath() != null
            && (u.getRawPath().startsWith("/login") || u.getRawPath().startsWith("/session"))) {
            return Action.PROVIDER_PAGE;
        }
        return Action.EXTERNAL;
    }

    static boolean sameOrigin(URI origin, URI url) {
        if (origin.getHost() == null || url.getHost() == null) return false;
        if (!"https".equalsIgnoreCase(origin.getScheme()) || !"https".equalsIgnoreCase(url.getScheme())) return false;
        return origin.getHost().equalsIgnoreCase(url.getHost()) && port(origin) == port(url);
    }

    private static int port(URI u) {
        return u.getPort() == -1 ? 443 : u.getPort();
    }
}
