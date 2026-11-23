package nl.mvlos.experiment;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PushOriginsTest {
    @Test
    public void onlyTheListedOriginsAreAllowed() {
        String list = "https://mvl.example, https://other.example:8443";
        assertTrue(PushOrigins.allowed(list, "https://mvl.example"));
        assertTrue(PushOrigins.allowed(list, "https://other.example:8443"));
        assertFalse(PushOrigins.allowed(list, "https://mvl.example:8443"));
        assertFalse(PushOrigins.allowed(list, "https://evil.example"));
        assertFalse(PushOrigins.allowed(list, "https://mvl.example.evil.example"));
        assertFalse(PushOrigins.allowed(list, "http://mvl.example"));
        assertFalse(PushOrigins.allowed(list, null));
        assertFalse(PushOrigins.allowed(list, ""));
        assertFalse(PushOrigins.allowed("", "https://mvl.example"));
        assertFalse(PushOrigins.allowed(null, "https://mvl.example"));
    }
}
