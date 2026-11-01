package nl.mvlos.experiment;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
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
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * The launcher: choose the bundled desktop on this device, or a cloud server that opens in the
 * user's browser as a Custom Tab (no WebView, no bridge, no tokens through the app).
 */
public class LauncherActivity extends AppCompatActivity {
    /** Set when the chooser is opened on purpose (Back, shortcut, web side); never auto-opens. */
    static final String EXTRA_CHOOSE = "nl.mvlos.experiment.extra.CHOOSE";

    private EditText urlField;
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
            openInBrowser(server);
        });
        disconnect.setOnClickListener(v -> confirmDisconnect());
        auto.setOnCheckedChangeListener((v, checked) -> AppPrefs.setAutoOpen(this, checked));

        if (autoServer != null) openInBrowser(autoServer);
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
        AppPrefs.setCloud(this, result.origin);
        refreshSaved();
        openInBrowser(result.origin);
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
            .setPositiveButton(R.string.disconnect, (d, w) -> {
                AppPrefs.forgetServer(this);
                urlField.setText("");
                urlField.setError(null);
                refreshSaved();
            })
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    /**
     * Opens the origin in a Custom Tab of a browser that supports them, else in any browser.
     * The site then uses that browser's own cookies; nothing passes through this app.
     */
    private void openInBrowser(String origin) {
        Uri uri = Uri.parse(origin + "/");
        String browser = CustomTabsClient.getPackageName(this, null);
        if (browser != null) {
            try {
                CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).build();
                tab.intent.setPackage(browser);
                tab.launchUrl(this, uri);
                return;
            } catch (ActivityNotFoundException ignored) {
                // Fall back to a plain browser view below.
            }
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            new AlertDialog.Builder(this)
                .setTitle(R.string.no_browser_title)
                .setMessage(R.string.no_browser_message)
                .setPositiveButton(android.R.string.ok, null)
                .show();
        }
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
