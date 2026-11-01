package nl.mvlos.experiment;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.util.Arrays;
import org.junit.Test;

public class CloudLoginCookiesTest {
    private static final String SID = "mvlos_sid=abcDEF123_-; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure";
    private static final String UID = "mvlos_uid=5; Path=/; Max-Age=2592000; SameSite=Lax; Secure";
    private static final String LOGIN = "mvlos_login=bob; Path=/; Max-Age=2592000; SameSite=Lax; Secure";

    @Test
    public void acceptsTheServersSessionCookies() {
        assertNotNull(CloudLogin.validCookies(Arrays.asList(SID, UID, LOGIN)));
    }

    @Test
    public void refusesAnythingElse() {
        assertNull(CloudLogin.validCookies(null));
        assertNull(CloudLogin.validCookies(Arrays.asList(UID, LOGIN)));
        assertNull(CloudLogin.validCookies(Arrays.asList(SID.replace("; HttpOnly", ""), UID)));
        assertNull(CloudLogin.validCookies(Arrays.asList(SID.replace("; Secure", ""), UID)));
        assertNull(CloudLogin.validCookies(Arrays.asList(SID + "; Domain=example.com", UID)));
        assertNull(CloudLogin.validCookies(Arrays.asList(SID.replace("Path=/", "Path=/api"), UID)));
        assertNull(CloudLogin.validCookies(Arrays.asList(SID, UID, "other=1; Path=/; Secure")));
        assertNull(CloudLogin.validCookies(Arrays.asList(SID, "mvlos_uid=5 6; Path=/; Secure")));
    }
}
