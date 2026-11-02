package nl.mvlos.experiment;

/**
 * What the app says when Android's Google sign-in doesn't return a token. Plain Java, tested.
 *
 * <p>Credential Manager reports two different things as GetCredentialCancellationException: the
 * person closing the account chooser ("activity is cancelled by the user.") and Google Play
 * services refusing to issue the token after an account was chosen (an ApiException with status 16,
 * message "16: …", for example when the app's Android OAuth client doesn't match). The second must
 * never look like nothing happened, so every failure is shown, with a short code to report.
 */
final class NativeGoogleErrors {
    /** The message androidx.credentials uses when the chooser activity ended without a result. */
    static final String USER_CANCEL_MESSAGE = "activity is cancelled by the user.";

    private NativeGoogleErrors() {}

    /** Whether this is the person closing the chooser, as opposed to a refusal reported as a cancellation. */
    static boolean userCancelled(String exceptionName, String message) {
        return "GetCredentialCancellationException".equals(exceptionName) && message != null && USER_CANCEL_MESSAGE.equalsIgnoreCase(message.trim());
    }

    /**
     * What may go to the system log: the exception's category and Google's numeric status if the
     * message starts with one ("[16] …" or "16: …"), never the free-form text.
     */
    static String logCode(String exceptionName, String message) {
        String name = code(exceptionName, null);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^\\s*\\[?(\\d{1,5})\\]?[:\\s]").matcher(message == null ? "" : message);
        return m.find() ? name + " status " + m.group(1) : name;
    }

    /**
     * A short code to show and report: the exception's name and its message, first line only,
     * printable ASCII, at most 120 characters. Google's messages carry status codes and reasons,
     * not account data.
     */
    static String code(String exceptionName, String message) {
        String name = exceptionName == null || exceptionName.isEmpty() ? "Error" : exceptionName.replace("GetCredential", "").replace("Exception", "");
        if (name.isEmpty()) name = "Error";
        String text = message == null ? "" : message.split("\n", 2)[0].replaceAll("[^\\x20-\\x7e]", "").trim();
        String out = text.isEmpty() ? name : name + ": " + text;
        return out.length() > 120 ? out.substring(0, 117) + "..." : out;
    }
}
