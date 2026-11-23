package nl.mvlos.experiment;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Shows one notification. Plain text, private on the lock screen (a generic version shows there). */
final class PushNotifier {
    private PushNotifier() {}

    static void post(Context c, String rid, String nid, long gen, String title, String text, String path) {
        if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return;
        PushOwner.channel(c);
        // The identity of the intent is in its data (rid and nid), not only in extras, so two
        // notifications can never share a PendingIntent.
        Intent open = new Intent(c, PushOpenActivity.class)
            .setData(Uri.parse("mvlospush://n/" + rid + "/" + nid))
            .putExtra("path", path)
            .putExtra("gen", gen)
            .putExtra("rid", rid);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification publicVersion = new NotificationCompat.Builder(c, PushOwner.CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(c.getString(R.string.app_name))
            .setContentText(c.getString(R.string.push_public))
            .build();
        Notification n = new NotificationCompat.Builder(c, PushOwner.CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build();
        try {
            NotificationManagerCompat.from(c).notify(nid, 0, n);
        } catch (SecurityException ignored) {
            // The notification permission was taken away meanwhile.
        }
    }
}
