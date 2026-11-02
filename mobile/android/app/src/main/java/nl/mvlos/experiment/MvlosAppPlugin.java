package nl.mvlos.experiment;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * The only native API the bundled desktop gets: read which mode it runs in, and go back to the
 * chooser. Deliberately nothing else: no URL opening, no storage, no tokens.
 * JS: {@code window.Capacitor.Plugins.MvlosApp.info()} / {@code .openChooser()}.
 */
@CapacitorPlugin(name = "MvlosApp")
public class MvlosAppPlugin extends Plugin {
    @PluginMethod
    public void info(PluginCall call) {
        JSObject result = new JSObject();
        result.put("mode", AppPrefs.MODE_LOCAL);
        String server = AppPrefs.server(getContext());
        result.put("savedServer", server != null ? server : JSONObject.NULL);
        result.put("version", versionName());
        call.resolve(result);
    }

    @PluginMethod
    public void openChooser(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity");
            return;
        }
        activity.runOnUiThread(() -> LauncherActivity.showChooser(activity));
        call.resolve();
    }

    private String versionName() {
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo info = pm.getPackageInfo(getContext().getPackageName(), 0);
            return info.versionName != null ? info.versionName : "";
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }
}
