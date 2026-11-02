package nl.mvlos.experiment;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

/**
 * Receives nl.mvlos.experiment:/oauth from the system browser at the end of a cloud sign-in. Any
 * app can send this intent, so nothing is trusted: the state must match the sign-in this app
 * started (CloudLogin), still fresh, before the result is handed to CloudActivity (not exported).
 * A code alone is worthless: redeeming it takes the verifier only this app holds.
 */
public class AuthReturnActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent in = getIntent();
        Uri data = in == null ? null : in.getData();
        Result r = parse(in == null ? null : in.getAction(), data);
        CloudLogin.Pending pending = CloudLogin.pending(this);
        if (r != null && pending != null && CloudLogin.same(r.state, pending.state)) {
            // A fresh, explicit intent: nothing of the incoming one (extras, clip data) is passed on.
            Intent out = new Intent(this, CloudActivity.class)
                .setAction(CloudActivity.ACTION_RETURN)
                .putExtra(CloudActivity.EXTRA_STATE, pending.state)
                .putExtra(CloudActivity.EXTRA_ORIGIN, pending.origin)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (r.code != null) out.putExtra(CloudActivity.EXTRA_CODE, r.code);
            if (r.error != null) out.putExtra(CloudActivity.EXTRA_ERROR, r.error);
            if (r.reason != null) out.putExtra(CloudActivity.EXTRA_REASON, r.reason);
            startActivity(out);
        } else if (r != null) {
            // Not this app's sign-in (or it expired): the one in progress, if any, is left alone.
            Toast.makeText(this, R.string.login_expired, Toast.LENGTH_LONG).show();
        }
        finish();
    }

    static final class Result {
        String state;
        String code;
        String error;
        String reason;
    }

    /**
     * Exactly nl.mvlos.experiment:/oauth (no authority, no fragment) with one state and either one
     * code or one known error. Anything else is ignored.
     */
    static Result parse(String action, Uri data) {
        if (!Intent.ACTION_VIEW.equals(action) || data == null) return null;
        if (!CloudLogin.REDIRECT_SCHEME.equals(data.getScheme()) || data.getEncodedAuthority() != null
            || !CloudLogin.REDIRECT_PATH.equals(data.getPath()) || data.getEncodedFragment() != null) return null;
        Result r = new Result();
        r.state = single(data, "state");
        r.code = single(data, "code");
        r.error = single(data, "error");
        r.reason = single(data, "reason");
        if (r.state == null || !r.state.matches("[A-Za-z0-9_-]{16,128}")) return null;
        if ((r.code == null) == (r.error == null)) return null;
        if (r.code != null && !r.code.matches("[A-Za-z0-9_-]{43}")) return null;
        if (r.error != null && !r.error.matches("closed|full|banned|denied|off|error")) return null;
        if (r.reason != null && (r.error == null || r.reason.length() > 200)) return null;
        return r;
    }

    private static String single(Uri data, String key) {
        java.util.List<String> values = data.getQueryParameters(key);
        return values.size() == 1 ? values.get(0) : (values.isEmpty() ? null : "\u0000");
    }
}
