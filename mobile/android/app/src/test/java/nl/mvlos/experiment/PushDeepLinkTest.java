package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class PushDeepLinkTest {
    private static final String U = "0123abcd-0123-0123-0123-0123456789ab";
    private static final String V = "fedcba98-0123-0123-0123-0123456789ab";

    @Test
    public void homeAndAppsPass() {
        assertEquals("/", PushDeepLink.validate("/"));
        assertEquals("/?open=mail", PushDeepLink.validate("/?open=mail"));
        assertEquals("/?open=calendar", PushDeepLink.validate("/?open=calendar"));
        assertEquals("/?open=tasks&task=" + U, PushDeepLink.validate("/?open=tasks&task=" + U));
        assertEquals("/?open=agents&thread=" + U, PushDeepLink.validate("/?open=agents&thread=" + U));
    }

    @Test
    public void theCanonicalOrderIsRebuilt() {
        assertEquals("/?open=agents&thread=" + U + "&task=" + V, PushDeepLink.validate("/?open=agents&task=" + V + "&thread=" + U));
    }

    @Test
    public void everythingElseIsRefused() {
        assertNull(PushDeepLink.validate(null));
        assertNull(PushDeepLink.validate(""));
        assertNull(PushDeepLink.validate("//evil.example/"));
        assertNull(PushDeepLink.validate("https://evil.example/"));
        assertNull(PushDeepLink.validate("/\\evil"));
        assertNull(PushDeepLink.validate("/?open=terminal"));
        assertNull(PushDeepLink.validate("/?open=settings"));
        assertNull(PushDeepLink.validate("/?open=mail&message=abc"));
        assertNull(PushDeepLink.validate("/?open=tasks&thread=" + U));
        assertNull(PushDeepLink.validate("/?open=agents&thread=../x"));
        assertNull(PushDeepLink.validate("/?open=agents&thread=" + U + "&thread=" + V));
        assertNull(PushDeepLink.validate("/?open=agents&open=mail"));
        assertNull(PushDeepLink.validate("/?open=agents&thread=" + U + "#frag"));
        assertNull(PushDeepLink.validate("/?open=agents&thread=%30" + U.substring(2)));
        assertNull(PushDeepLink.validate("/?open=mail@evil"));
        assertNull(PushDeepLink.validate("/?open="));
        assertNull(PushDeepLink.validate("/?open=agents&thread="));
        assertNull(PushDeepLink.validate("/?open=agents&=x"));
        assertNull(PushDeepLink.validate("/?open=agents&thread=" + U + "&evil=1"));
        assertNull(PushDeepLink.validate("/index.html?open=mail"));
        assertNull(PushDeepLink.validate("/?open=mail\n"));
        assertNull(PushDeepLink.validate("/?open=mail " ));
        StringBuilder long513 = new StringBuilder("/?open=mail");
        while (long513.length() < 513) long513.append('a');
        assertNull(PushDeepLink.validate(long513.toString()));
    }
}
