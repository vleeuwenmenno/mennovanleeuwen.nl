package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerUrlTest {
    private static void accepts(String input, String origin) {
        ServerUrl.Result r = ServerUrl.normalize(input);
        assertTrue("expected ok for " + input + " but got " + r.error, r.ok());
        assertNull(r.error);
        assertEquals(origin, r.origin);
    }

    private static void rejects(String input, ServerUrl.Error error) {
        ServerUrl.Result r = ServerUrl.normalize(input);
        assertFalse("expected rejection for " + input + " but got " + r.origin, r.ok());
        assertNull(r.origin);
        assertEquals("error for " + input, error, r.error);
    }

    @Test
    public void normalizesToOrigin() {
        accepts("https://example.com", "https://example.com");
        accepts("https://example.com/", "https://example.com");
        accepts("https://example.com/some/path?q=1#frag", "https://example.com");
        accepts("https://example.com?x", "https://example.com");
        accepts("https://example.com#x", "https://example.com");
        accepts("  https://example.com  ", "https://example.com");
    }

    @Test
    public void schemeIsCaseInsensitiveAndHostIsLowerCased() {
        accepts("HTTPS://Example.COM", "https://example.com");
        accepts("HtTpS://os.Example.com/", "https://os.example.com");
    }

    @Test
    public void addsHttpsWhenSchemeIsMissing() {
        accepts("example.com", "https://example.com");
        accepts("example.com/path", "https://example.com");
        accepts("example.com:8443", "https://example.com:8443");
        accepts("example.com:8443/x", "https://example.com:8443");
    }

    @Test
    public void handlesPorts() {
        accepts("https://example.com:443", "https://example.com");
        accepts("https://example.com:8443", "https://example.com:8443");
        accepts("https://example.com:1", "https://example.com:1");
        accepts("https://example.com:65535", "https://example.com:65535");
        rejects("https://example.com:0", ServerUrl.Error.INVALID_PORT);
        rejects("https://example.com:65536", ServerUrl.Error.INVALID_PORT);
        rejects("https://example.com:", ServerUrl.Error.INVALID_PORT);
        rejects("https://example.com:12a", ServerUrl.Error.INVALID_PORT);
        rejects("https://example.com:123456", ServerUrl.Error.INVALID_PORT);
        rejects("https://example.com:-1", ServerUrl.Error.INVALID_PORT);
    }

    @Test
    public void rejectsOtherSchemes() {
        rejects("http://example.com", ServerUrl.Error.NOT_HTTPS);
        rejects("HTTP://example.com", ServerUrl.Error.NOT_HTTPS);
        rejects("ftp://example.com", ServerUrl.Error.NOT_HTTPS);
        rejects("javascript:alert(1)", ServerUrl.Error.NOT_HTTPS);
        rejects("file:///etc/passwd", ServerUrl.Error.NOT_HTTPS);
        rejects("intent://x#Intent;end", ServerUrl.Error.NOT_HTTPS);
        rejects("https:example.com", ServerUrl.Error.INVALID);
        rejects("http:example.com", ServerUrl.Error.INVALID);
        rejects("://example.com", ServerUrl.Error.INVALID);
    }

    @Test
    public void rejectsUserInfo() {
        rejects("https://user@x.com", ServerUrl.Error.USERINFO);
        rejects("https://user:pass@x.com", ServerUrl.Error.USERINFO);
        rejects("https://x.com@evil.com", ServerUrl.Error.USERINFO);
        rejects("user@x.com", ServerUrl.Error.USERINFO);
    }

    @Test
    public void rejectsWhitespaceAndControlCharacters() {
        rejects("", ServerUrl.Error.EMPTY);
        rejects("   ", ServerUrl.Error.EMPTY);
        rejects(null, ServerUrl.Error.EMPTY);
        rejects("https://exa mple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://example.com\n.evil", ServerUrl.Error.INVALID_CHARACTERS);
        accepts("\thttps://example.com\t\n", "https://example.com");
        rejects("https://exa\u0000mple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://exa\u007fmple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://exa\u0085mple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://exa mple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://exa​mple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://exa‮mple.com", ServerUrl.Error.INVALID_CHARACTERS);
        rejects("https://example.com\\@evil.com", ServerUrl.Error.INVALID_CHARACTERS);
    }

    @Test
    public void rejectsBadHosts() {
        rejects("https://", ServerUrl.Error.INVALID_HOST);
        rejects("https:///path", ServerUrl.Error.INVALID_HOST);
        rejects("https://:443", ServerUrl.Error.INVALID_HOST);
        rejects("https://exa_mple.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://-example.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://example-.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://example..com", ServerUrl.Error.INVALID_HOST);
        rejects("https://example.com.", ServerUrl.Error.INVALID_HOST);
        rejects("https://.example.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://exa%41mple.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://exa<mple.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://exa\"mple.com", ServerUrl.Error.INVALID_HOST);
        rejects("https://" + repeat("a", 64) + ".com", ServerUrl.Error.INVALID_HOST);
        rejects("https://a:b:c", ServerUrl.Error.INVALID_HOST);
    }

    @Test
    public void convertsInternationalHostsToAscii() {
        accepts("https://bücher.example", "https://xn--bcher-kva.example");
        accepts("https://BÜCHER.example/pfad", "https://xn--bcher-kva.example");
        accepts("münchen.de:8443", "https://xn--mnchen-3ya.de:8443");
        accepts("https://xn--bcher-kva.example", "https://xn--bcher-kva.example");
    }

    @Test
    public void handlesIpv4() {
        accepts("https://192.168.1.10", "https://192.168.1.10");
        accepts("https://10.0.0.1:8443", "https://10.0.0.1:8443");
        rejects("https://256.1.1.1", ServerUrl.Error.INVALID_HOST);
        rejects("https://127.1", ServerUrl.Error.INVALID_HOST);
        rejects("https://0x7f.0.0.1", ServerUrl.Error.INVALID_HOST);
        rejects("https://010.0.0.1", ServerUrl.Error.INVALID_HOST);
        rejects("https://2130706433", ServerUrl.Error.INVALID_HOST);
        rejects("https://1.2.3.4.5", ServerUrl.Error.INVALID_HOST);
        rejects("https://example.0x10", ServerUrl.Error.INVALID_HOST);
    }

    @Test
    public void handlesIpv6() {
        accepts("https://[::1]", "https://[::1]");
        accepts("https://[2001:DB8::1]:8443/x", "https://[2001:db8::1]:8443");
        accepts("[2001:db8::1]", "https://[2001:db8::1]");
        accepts("https://[::ffff:192.168.0.1]", "https://[::ffff:c0a8:1]");
        accepts("https://[1:2:3:4:5:6:7:8]", "https://[1:2:3:4:5:6:7:8]");
        rejects("https://[::1", ServerUrl.Error.INVALID_HOST);
        rejects("https://[1:2:3]", ServerUrl.Error.INVALID_HOST);
        rejects("https://[1::2::3]", ServerUrl.Error.INVALID_HOST);
        rejects("https://[fe80::1%25eth0]", ServerUrl.Error.INVALID_HOST);
        rejects("https://[12345::1]", ServerUrl.Error.INVALID_HOST);
        rejects("https://[::1]x", ServerUrl.Error.INVALID_HOST);
        rejects("https://[1:2:3:4:5:6:7:8:9]", ServerUrl.Error.INVALID_HOST);
        rejects("https://[:1:2:3:4:5:6:7]", ServerUrl.Error.INVALID_HOST);
        rejects("https://::1", ServerUrl.Error.INVALID_HOST);
    }

    private static String repeat(String s, int n) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < n; i++) b.append(s);
        return b.toString();
    }
}
