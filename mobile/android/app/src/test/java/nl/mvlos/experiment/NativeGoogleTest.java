package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeGoogleTest {
    private static final String C = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    @Test
    public void nonceIsWhatTheServerComputes() {
        // server/appLogin.ts nativeNonce: base64url(SHA-256(challenge + "\n" + origin)), from Node.
        assertEquals("Sri6oqfkz1c_xmC3Flf8KKGt_2zcs73LqF3yxpagG8k", NativeGoogle.nonce(C, "https://mennovanleeuwen.nl"));
        assertNotEquals(NativeGoogle.nonce(C, "https://mennovanleeuwen.nl"), NativeGoogle.nonce(C, "https://evil.example"));
    }

    @Test
    public void onlyTrustedServersGetThePicker() {
        assertTrue(NativeGoogle.allowedOrigin("https://mennovanleeuwen.nl"));
        assertFalse(NativeGoogle.allowedOrigin("https://mennovanleeuwen.nl.evil.example"));
        assertFalse(NativeGoogle.allowedOrigin("https://evil.example"));
        assertFalse(NativeGoogle.allowedOrigin(null));
    }
}
