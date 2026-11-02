package nl.mvlos.experiment;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The 1.4 bug: after an account was chosen, Google Play services refused the token (ApiException
 * status 16), androidx.credentials reported it as GetCredentialCancellationException, and the app
 * treated every cancellation as the person closing the chooser: nothing was shown at all.
 */
public class NativeGoogleErrorsTest {
    private static final String CANCEL = "GetCredentialCancellationException";

    @Test
    public void aRefusalReportedAsCancellationIsNotAUserCancel() {
        assertFalse(NativeGoogleErrors.userCancelled(CANCEL, "16: Account reauth failed."));
        assertFalse(NativeGoogleErrors.userCancelled(CANCEL, "16: Cancelled by user."));
        assertFalse(NativeGoogleErrors.userCancelled(CANCEL, null));
        assertFalse(NativeGoogleErrors.userCancelled("GetCredentialUnknownException", "activity is cancelled by the user."));
    }

    @Test
    public void closingTheChooserIsAUserCancel() {
        assertTrue(NativeGoogleErrors.userCancelled(CANCEL, "activity is cancelled by the user."));
        assertTrue(NativeGoogleErrors.userCancelled(CANCEL, " Activity is cancelled by the user. "));
    }

    @Test
    public void logsCarryOnlyTheCategoryAndStatus() {
        assertEquals("Cancellation status 16", NativeGoogleErrors.logCode(CANCEL, "[16] Account reauth failed for someone@example.com"));
        assertEquals("Cancellation status 16", NativeGoogleErrors.logCode(CANCEL, "16: Cancelled by user."));
        assertEquals("Unknown status 28444", NativeGoogleErrors.logCode("GetCredentialUnknownException", "[28444] Developer console is not set up correctly."));
        assertEquals("Cancellation", NativeGoogleErrors.logCode(CANCEL, "activity is cancelled by the user."));
        assertEquals("Unknown", NativeGoogleErrors.logCode("GetCredentialUnknownException", "eyJhbGciOiJSUzI1NiJ9.secret"));
    }

    @Test
    public void codesAreShortAndPrintable() {
        assertEquals("Cancellation: 16: Account reauth failed.", NativeGoogleErrors.code(CANCEL, "16: Account reauth failed.\nmore"));
        assertEquals("Unknown: [28444] Developer console is not set up correctly.", NativeGoogleErrors.code("GetCredentialUnknownException", "[28444] Developer console is not set up correctly."));
        assertEquals("NoCredential", NativeGoogleErrors.code("NoCredentialException", null));
        assertEquals("Error", NativeGoogleErrors.code(null, ""));
        String longText = new String(new char[300]).replace('\0', 'x');
        assertEquals(120, NativeGoogleErrors.code(CANCEL, longText).length());
        assertFalse(NativeGoogleErrors.code(CANCEL, "a\u0000b‮c").contains("‮"));
    }
}
