// The helper's screen: starts the relay service when opened, shows whether it runs, and opens the game.
// GPL-3.0-or-later.
package io.github.sgtmetz.openspadeshelper;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
    private TextView status;
    private Button toggle;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        int pad = dp(20);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad * 2, pad, pad);
        col.setBackgroundColor(Color.rgb(11, 20, 36));

        TextView title = text("OpenSpades Helper", 26);
        title.setTextColor(Color.WHITE);
        col.addView(title);
        TextView about = text("Lets the OpenSpades web game join every server, including the ones marked [Needs Helper], "
            + "by connecting from this phone's own internet connection instead of a data centre.\n\n"
            + "Keep the helper running (it shows a notification), then play in Chrome or Firefox on this phone. "
            + "The first time, the browser may ask whether the site may connect to apps on your device: allow it.", 15);
        about.setPadding(0, dp(12), 0, dp(12));
        col.addView(about);

        status = text("", 17);
        status.setPadding(0, dp(8), 0, dp(16));
        col.addView(status);

        toggle = new Button(this);
        toggle.setOnClickListener(v -> {
            if (HelperService.status == null) HelperService.start(this); else HelperService.stop(this);
        });
        col.addView(toggle);

        String site = siteUrl();
        if (site != null) {
            Button play = new Button(this);
            play.setText("Play OpenSpades in the browser");
            play.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(site))));
            col.addView(play);
        }

        TextView small = text("It only listens on this phone (127.0.0.1:" + Relay.PORT + "), only accepts "
            + (site != null ? Uri.parse(site).getHost() : "the game's website") + ", and only forwards game traffic to public game servers. "
            + "Stop it from its notification or here when you are done. Source code: GPL-3.0-or-later.", 13);
        small.setTextColor(Color.rgb(133, 151, 179));
        small.setPadding(0, dp(20), 0, 0);
        col.addView(small);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(11, 20, 36));
        scroll.addView(col);
        // Android 15+ draws apps edge to edge (older versions lay out below the bars): keep the text clear of the status and navigation bars
        if (Build.VERSION.SDK_INT >= 30) scroll.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(scroll);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
        if (HelperService.status == null) HelperService.start(this);
    }

    /** The first allowed https origin (the game's site), or null for a build without one. */
    private static String siteUrl() {
        for (String o : Relay.allowedList()) if (o.startsWith("https://")) return o + "/";
        return null;
    }

    @Override
    protected void onResume() {
        super.onResume();
        HelperService.onChange = () -> runOnUiThread(this::refresh);
        refresh();
    }

    @Override
    protected void onPause() {
        HelperService.onChange = null;
        super.onPause();
    }

    private void refresh() {
        String s = HelperService.status;
        boolean running = "running".equals(s);
        status.setText(s == null ? "The helper is stopped." : running ? "The helper is running." : "Problem: " + s);
        status.setTextColor(running ? Color.rgb(120, 214, 106) : s == null ? Color.rgb(219, 230, 245) : Color.rgb(255, 123, 123));
        toggle.setText(s == null ? "Start the helper" : "Stop the helper");
    }

    private TextView text(String s, int sp) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.rgb(219, 230, 245));
        t.setGravity(Gravity.START);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
