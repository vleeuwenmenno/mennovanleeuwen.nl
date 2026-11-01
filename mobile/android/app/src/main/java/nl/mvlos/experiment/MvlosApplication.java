package nl.mvlos.experiment;

import android.app.Application;
import android.webkit.WebView;

/**
 * Gives the cloud desktop's process (":cloud", CloudActivity) a WebView data directory of its own,
 * so its cookies, storage, cache and service workers never mix with the on-device desktop's
 * (Capacitor, main process), and resetting it touches nothing else. Must run before any WebView
 * exists in that process.
 */
public class MvlosApplication extends Application {
    static final String CLOUD_PROCESS_SUFFIX = ":cloud";

    static boolean inCloudProcess() {
        String name = Application.getProcessName();
        return name != null && name.endsWith(CLOUD_PROCESS_SUFFIX);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (inCloudProcess()) WebView.setDataDirectorySuffix("cloud");
    }
}
