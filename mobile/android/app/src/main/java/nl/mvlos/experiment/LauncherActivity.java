package nl.mvlos.experiment;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * The launcher: choose the bundled desktop on this device, or a cloud server whose desktop opens
 * full screen inside the app (CloudActivity: a plain WebView in its own process, no bridge).
 */
public class LauncherActivity extends AppCompatActivity {
    /** Set when the chooser is opened on purpose (Back, shortcut, web side); never auto-opens. */
    static final String EXTRA_CHOOSE = "nl.mvlos.experiment.extra.CHOOSE";

    private EditText urlField;
    /**
     * What waits for the reset of the previous server's cloud data (CloudResetActivity): forget it
     * (disconnect), or switch to `pendingServer`. Kept across recreation; done only after a reset
     * that finished.
     */
    private String pendingAction;
    private String pendingServer;
    private final androidx.activity.result.ActivityResultLauncher<Intent> reset =
        registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult(), r -> {
            String action = pendingAction;
            String server = pendingServer;
            pendingAction = null;
            pendingServer = null;
            Intent data = r.getData();
            if (r.getResultCode() != RESULT_OK || data == null) {
                android.widget.Toast.makeText(this, R.string.reset_incomplete, android.widget.Toast.LENGTH_LONG).show();
                return;
            }
            if (data.getBooleanExtra(CloudResetActivity.EXTRA_WIPE_DIRS, false) && !CloudResetActivity.deleteCloudData(this)) {
                android.widget.Toast.makeText(this, R.string.reset_incomplete, android.widget.Toast.LENGTH_LONG).show();
                return;
            }
            if (data.getBooleanExtra(CloudResetActivity.EXTRA_HAD_SESSION, false)
                && !data.getBooleanExtra(CloudResetActivity.EXTRA_SIGNED_OUT, false)) {
                android.widget.Toast.makeText(this, R.string.reset_unconfirmed, android.widget.Toast.LENGTH_LONG).show();
            }
            if ("switch".equals(action) && server != null) {
                AppPrefs.setCloud(this, server);
                openCloud();
            } else if ("disconnect".equals(action)) {
                AppPrefs.forgetServer(this);
                if (urlField != null) {
                    urlField.setText("");
                    urlField.setError(null);
                }
                refreshSaved();
            }
        });

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("pendingAction", pendingAction);
        out.putString("pendingServer", pendingServer);
    }
    private View savedGroup;
    private TextView savedLabel;

    /** Shows the chooser without auto-opening and closes {@code from}. */
    static void showChooser(Activity from) {
        Intent intent = new Intent(from, LauncherActivity.class).putExtra(EXTRA_CHOOSE, true);
        from.startActivity(intent);
        from.finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            pendingAction = savedInstanceState.getString("pendingAction");
            pendingServer = savedInstanceState.getString("pendingServer");
        }

        // Auto-open only on a fresh launch from the home screen, never on rotation, from Recents,
        // from the "Choose mode" shortcut or when coming back from the desktop.
        Intent intent = getIntent();
        boolean freshLaunch = savedInstanceState == null
            && Intent.ACTION_MAIN.equals(intent.getAction())
            && intent.hasCategory(Intent.CATEGORY_LAUNCHER)
            && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
            && !intent.getBooleanExtra(EXTRA_CHOOSE, false);
        String autoServer = null;
        if (freshLaunch && AppPrefs.autoOpen(this)) {
            String mode = AppPrefs.mode(this);
            if (AppPrefs.MODE_LOCAL.equals(mode)) {
                openLocal();
                return;
            }
            if (AppPrefs.MODE_CLOUD.equals(mode)) autoServer = AppPrefs.server(this);
        }

        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_launcher);
        Immersive.enter(this);
        View root = findViewById(R.id.launcher_root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        urlField = findViewById(R.id.server_url);
        savedGroup = findViewById(R.id.saved_group);
        savedLabel = findViewById(R.id.saved_label);
        Button local = findViewById(R.id.open_local);
        Button connect = findViewById(R.id.connect);
        Button openSaved = findViewById(R.id.open_saved);
        Button disconnect = findViewById(R.id.disconnect);
        CheckBox auto = findViewById(R.id.auto_open);

        String saved = AppPrefs.server(this);
        if (savedInstanceState == null && saved != null) urlField.setText(saved);
        auto.setChecked(AppPrefs.autoOpen(this));
        refreshSaved();

        local.setOnClickListener(v -> openLocal());
        connect.setOnClickListener(v -> connect());
        urlField.setOnEditorActionListener((v, actionId, event) -> {
            boolean enter = event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                && event.getAction() == KeyEvent.ACTION_DOWN;
            if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                connect();
                return true;
            }
            return false;
        });
        openSaved.setOnClickListener(v -> {
            String server = AppPrefs.server(this);
            if (server == null) {
                refreshSaved();
                return;
            }
            AppPrefs.setCloud(this, server);
            openCloud();
        });
        disconnect.setOnClickListener(v -> confirmDisconnect());
        auto.setOnCheckedChangeListener((v, checked) -> AppPrefs.setAutoOpen(this, checked));

        if (autoServer != null) openCloud();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && findViewById(R.id.launcher_root) != null) Immersive.enter(this);
    }

    private void refreshSaved() {
        String saved = AppPrefs.server(this);
        savedGroup.setVisibility(saved != null ? View.VISIBLE : View.GONE);
        if (saved != null) savedLabel.setText(getString(R.string.saved_server, saved));
    }

    private void openLocal() {
        AppPrefs.setMode(this, AppPrefs.MODE_LOCAL);
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private void connect() {
        ServerUrl.Result result = ServerUrl.normalize(urlField.getText().toString());
        if (!result.ok()) {
            urlField.setError(getString(errorText(result.error)));
            urlField.requestFocus();
            return;
        }
        urlField.setError(null);
        urlField.setText(result.origin);
        urlField.setSelection(result.origin.length());
        String previous = AppPrefs.server(this);
        if (previous != null && !previous.equals(result.origin)) {
            // Another server: the app signs out of the old one and forgets its data first.
            new AlertDialog.Builder(this)
                .setTitle(getString(R.string.switch_title, result.origin))
                .setMessage(getString(R.string.switch_message, previous))
                .setPositiveButton(R.string.switch_confirm, (d, w) -> resetCloud(previous, "switch", result.origin))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
            return;
        }
        AppPrefs.setCloud(this, result.origin);
        refreshSaved();
        openCloud();
    }

    /** Signs the app out of `origin` and deletes the cloud WebView's data, then does `action`. */
    private void resetCloud(String origin, String action, String next) {
        pendingAction = action;
        pendingServer = next;
        // Push stops first, here in the process that owns it (off the UI thread: storage and the
        // Keystore are involved): nothing arrives or shows after Disconnect begins.
        new Thread(() -> {
            try {
                PushController.revokeLocal(this);
            } catch (RuntimeException ignored) {
                // The reset still revokes through the owner and waits for its acknowledgement.
            }
            runOnUiThread(() -> reset.launch(new Intent(this, CloudResetActivity.class).putExtra(CloudResetActivity.EXTRA_ORIGIN, origin)));
        }).start();
    }

    private void openCloud() {
        String server = AppPrefs.server(this);
        if (server == null) return;
        startActivity(new Intent(this, CloudActivity.class).putExtra(CloudActivity.EXTRA_ORIGIN, server));
        finish();
    }

    private void confirmDisconnect() {
        String saved = AppPrefs.server(this);
        if (saved == null) {
            refreshSaved();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle(getString(R.string.disconnect_title, saved))
            .setMessage(R.string.disconnect_message)
            .setPositiveButton(R.string.disconnect, (d, w) -> resetCloud(saved, "disconnect", null))
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    private static int errorText(ServerUrl.Error error) {
        if (error == null) return R.string.error_invalid;
        switch (error) {
            case EMPTY: return R.string.error_empty;
            case NOT_HTTPS: return R.string.error_not_https;
            case INVALID_CHARACTERS: return R.string.error_characters;
            case USERINFO: return R.string.error_userinfo;
            case INVALID_HOST: return R.string.error_host;
            case INVALID_PORT: return R.string.error_port;
            default: return R.string.error_invalid;
        }
    }
}
