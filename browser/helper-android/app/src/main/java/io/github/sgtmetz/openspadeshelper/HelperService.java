// Keeps the relay running while the player is in the browser: a foreground service with an ongoing notification
// (Android stops background apps' network servers otherwise). GPL-3.0-or-later.
package io.github.sgtmetz.openspadeshelper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import java.io.IOException;

public class HelperService extends Service {
    static final String ACTION_STOP = "io.github.sgtmetz.openspadeshelper.STOP";
    private static final String CHANNEL = "helper";
    private static final int NOTIFICATION = 1;

    /** What the screen shows: null while stopped, otherwise a status line. Read on the main thread. */
    static volatile String status = null;
    static volatile Runnable onChange = null;

    private Relay relay;
    private int open = 0;

    static void start(Context c) {
        c.startForegroundService(new Intent(c, HelperService.class));
    }

    static void stop(Context c) {
        c.startService(new Intent(c, HelperService.class).setAction(ACTION_STOP));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.app_name), NotificationManager.IMPORTANCE_LOW));
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION, notification());
        if (relay == null) {
            relay = new Relay(n -> { open = n; update(); });
            try {
                relay.start();
                status = "running";
            } catch (IOException e) {
                relay = null;
                status = "could not listen on 127.0.0.1:" + Relay.PORT + " (" + e.getMessage() + ")";
            }
            update();
        }
        return START_STICKY;
    }

    private void update() {
        Runnable r = onChange;
        if (r != null) r.run();
        if (status != null) getSystemService(NotificationManager.class).notify(NOTIFICATION, notification());
    }

    private Notification notification() {
        PendingIntent openApp = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, HelperService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        String text = relay == null ? (status == null ? "Starting" : status)
            : open == 0 ? "Running. Play in your browser; the game connects through the helper."
            : "Relaying " + open + (open == 1 ? " game connection" : " game connections");
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(openApp)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
            .build();
    }

    @Override
    public void onDestroy() {
        if (relay != null) relay.stop();
        relay = null;
        status = null;
        Runnable r = onChange;
        if (r != null) r.run();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
