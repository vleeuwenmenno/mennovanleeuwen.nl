package nl.mvlos.experiment;

import java.net.IDN;
import java.util.Locale;

/**
 * Validates a cloud server address typed by the user and reduces it to an HTTPS origin.
 *
 * <p>Plain Java (no Android classes) so it runs in local JUnit tests. The result is only ever
 * opened in the user's browser, never in the app's WebView, but it is still validated strictly:
 * HTTPS only, a real host name or IP literal, no user info, no whitespace or control characters.
 */
public final class ServerUrl {
    /** Why an address was rejected. LauncherActivity maps each to a string resource. */
    public enum Error {
        EMPTY,
        NOT_HTTPS,
        INVALID_CHARACTERS,
        USERINFO,
        INVALID_HOST,
        INVALID_PORT,
        INVALID
    }

    /** Either an origin or an error. */
    public static final class Result {
        public final String origin;
        public final Error error;

        private Result(String origin, Error error) {
            this.origin = origin;
            this.error = error;
        }

        public boolean ok() {
            return origin != null;
        }

        static Result of(String origin) {
            return new Result(origin, null);
        }

        static Result fail(Error error) {
            return new Result(null, error);
        }
    }

    private static final int MAX_INPUT = 2048;

    private ServerUrl() {}

    /**
     * Normalizes {@code input} to {@code https://host[:port]}. Input without a scheme gets
     * {@code https://}; an explicit {@code http://} (or any other scheme) is rejected rather than
     * silently upgraded, so the user knows exactly what the app connects to.
     */
    public static Result normalize(String input) {
        if (input == null) return Result.fail(Error.EMPTY);
        String s = input.trim();
        if (s.isEmpty()) return Result.fail(Error.EMPTY);
        if (s.length() > MAX_INPUT) return Result.fail(Error.INVALID);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || Character.isWhitespace(c)
                || Character.isSpaceChar(c) || c == '\\' || Character.getType(c) == Character.FORMAT) {
                return Result.fail(Error.INVALID_CHARACTERS);
            }
        }

        String rest;
        int sep = s.indexOf("://");
        if (sep >= 0) {
            String scheme = s.substring(0, sep);
            if (scheme.equalsIgnoreCase("https")) {
                rest = s.substring(sep + 3);
            } else if (scheme.equalsIgnoreCase("http")) {
                return Result.fail(Error.NOT_HTTPS);
            } else if (scheme.matches("[A-Za-z][A-Za-z0-9+.-]*")) {
                return Result.fail(Error.NOT_HTTPS);
            } else {
                return Result.fail(Error.INVALID);
            }
        } else {
            String lower = s.toLowerCase(Locale.ROOT);
            // "https:host", "http:host", "javascript:..." and similar are not bare host names.
            if (lower.startsWith("http:") || lower.startsWith("https:")) return Result.fail(Error.INVALID);
            int colon = s.indexOf(':');
            if (colon > 0 && !s.startsWith("[") && !looksLikePort(s, colon)) {
                return Result.fail(Error.NOT_HTTPS);
            }
            rest = s;
        }

        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                end = i;
                break;
            }
        }
        String authority = rest.substring(0, end);
        if (authority.indexOf('@') >= 0) return Result.fail(Error.USERINFO);
        if (authority.isEmpty()) return Result.fail(Error.INVALID_HOST);

        String host;
        String port = null;
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close < 0) return Result.fail(Error.INVALID_HOST);
            String literal = authority.substring(1, close).toLowerCase(Locale.ROOT);
            if (!isIpv6(literal)) return Result.fail(Error.INVALID_HOST);
            host = "[" + literal + "]";
            String after = authority.substring(close + 1);
            if (!after.isEmpty()) {
                if (!after.startsWith(":")) return Result.fail(Error.INVALID_HOST);
                port = after.substring(1);
            }
        } else {
            int colon = authority.lastIndexOf(':');
            String rawHost = colon >= 0 ? authority.substring(0, colon) : authority;
            if (colon >= 0) port = authority.substring(colon + 1);
            if (rawHost.isEmpty() || rawHost.indexOf(':') >= 0 || rawHost.indexOf('[') >= 0
                || rawHost.indexOf(']') >= 0) {
                return Result.fail(Error.INVALID_HOST);
            }
            host = asciiHost(rawHost);
            if (host == null) return Result.fail(Error.INVALID_HOST);
        }

        String portSuffix = "";
        if (port != null) {
            if (!port.matches("[0-9]{1,5}")) return Result.fail(Error.INVALID_PORT);
            int n = Integer.parseInt(port);
            if (n < 1 || n > 65535) return Result.fail(Error.INVALID_PORT);
            if (n != 443) portSuffix = ":" + n;
        }
        return Result.of("https://" + host + portSuffix);
    }

    /** True when the text after {@code colon} is a port (digits up to the path), as in "host:8443". */
    private static boolean looksLikePort(String s, int colon) {
        int i = colon + 1;
        int digits = 0;
        while (i < s.length() && Character.isDigit(s.charAt(i)) && s.charAt(i) < 128) {
            i++;
            digits++;
        }
        return digits > 0 && (i == s.length() || "/?#".indexOf(s.charAt(i)) >= 0);
    }

    /** Converts a host name to lower-case ASCII (punycode) and checks its syntax; null if invalid. */
    static String asciiHost(String raw) {
        String ascii;
        try {
            ascii = IDN.toASCII(raw, IDN.USE_STD3_ASCII_RULES);
        } catch (IllegalArgumentException e) {
            return null;
        }
        ascii = ascii.toLowerCase(Locale.ROOT);
        if (ascii.isEmpty() || ascii.length() > 253) return null;
        String[] labels = ascii.split("\\.", -1);
        for (String label : labels) {
            if (label.isEmpty() || label.length() > 63) return null;
            if (label.startsWith("-") || label.endsWith("-")) return null;
            for (int i = 0; i < label.length(); i++) {
                char c = label.charAt(i);
                boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-';
                if (!ok) return null;
            }
        }
        // Browsers read a host whose last label is numeric (or hex) as an IPv4 address, in
        // shorthand forms like "127.1" or "0x7f.1" too. Only accept plain dotted quads.
        String last = labels[labels.length - 1];
        if (last.matches("[0-9]+") || last.matches("0x[0-9a-f]*")) {
            return isDottedQuad(labels) ? ascii : null;
        }
        return ascii;
    }

    private static boolean isDottedQuad(String[] labels) {
        if (labels.length != 4) return false;
        for (String part : labels) {
            if (!part.matches("[0-9]{1,3}")) return false;
            if (part.length() > 1 && part.charAt(0) == '0') return false;
            if (Integer.parseInt(part) > 255) return false;
        }
        return true;
    }

    /** Lower-case IPv6 literal without brackets or zone id; embedded IPv4 tail allowed. */
    static boolean isIpv6(String s) {
        if (s.isEmpty() || !s.matches("[0-9a-f:.]+")) return false;
        int doubleColon = s.indexOf("::");
        if (doubleColon >= 0 && s.indexOf("::", doubleColon + 1) >= 0) return false;
        int groups = 0;
        String[] parts = s.split(":", -1);
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty()) {
                // Empty parts only come from "::" (at the start, end or middle).
                boolean fromDouble = doubleColon >= 0;
                if (!fromDouble) return false;
                continue;
            }
            if (part.indexOf('.') >= 0) {
                if (i != parts.length - 1) return false;
                if (!isDottedQuad(part.split("\\.", -1))) return false;
                groups += 2;
            } else {
                if (part.length() > 4) return false;
                groups++;
            }
        }
        if (s.startsWith(":") && !s.startsWith("::")) return false;
        if (s.endsWith(":") && !s.endsWith("::")) return false;
        return doubleColon >= 0 ? groups < 8 : groups == 8;
    }
}
