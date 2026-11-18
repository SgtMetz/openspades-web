// OpenSpades Mobile — consent (Google UMP) and the interstitial ad shown after the player dies. GPL-3.0-or-later.
package app.openspadesweb.mobile;

import android.os.SystemClock;
import android.util.Log;

import androidx.activity.ComponentActivity;
import androidx.annotation.NonNull;

import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Shows at most one full-screen ad per {@link #COOLDOWN_MS}, only when the player has just died (a natural break:
 * the respawn countdown is running anyway). The first ad can appear no sooner than {@link #FIRST_AD_DELAY_MS}
 * after launch. Ads are requested only after the consent flow says they may be (GDPR/UK/US-state rules).
 */
final class AdManager {
    interface Listener {
        /** The ad covered (true) or uncovered (false) the game. */
        void onAdShowing(boolean showing);
        /** Whether Settings must offer "Privacy & ad choices" (required in regions with a consent form). */
        void onPrivacyOptionsRequired(boolean required);
    }

    private static final String TAG = "OpenSpadesAds";
    static final long COOLDOWN_MS = 4 * 60_000L;
    static final long FIRST_AD_DELAY_MS = 3 * 60_000L;
    private static final long RETRY_MS = 60_000L;

    private final ComponentActivity activity;
    private final Listener listener;
    private final String adUnitId;
    private final ConsentInformation consent;
    private final AtomicBoolean sdkStarted = new AtomicBoolean(false);
    private InterstitialAd ad;
    private boolean loading, showing;
    private long lastShownAt, lastFailedAt = -RETRY_MS;
    private final long startedAt = SystemClock.elapsedRealtime();

    AdManager(ComponentActivity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        this.adUnitId = activity.getString(R.string.interstitial_ad_unit_id);
        this.consent = UserMessagingPlatform.getConsentInformation(activity);
    }

    /** Call once from onCreate: updates consent, shows the consent form if needed, then starts the ads SDK. */
    void start() {
        ConsentRequestParameters params = new ConsentRequestParameters.Builder().build();
        consent.requestConsentInfoUpdate(activity, params,
                () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, error -> {
                    if (error != null) Log.w(TAG, "Consent form: " + error.getMessage());
                    afterConsent();
                }),
                error -> { Log.w(TAG, "Consent update: " + error.getMessage()); afterConsent(); });
        // A consent decision from an earlier launch lets ads start loading without waiting for the network round trip.
        if (consent.canRequestAds()) startSdk();
    }

    private void afterConsent() {
        listener.onPrivacyOptionsRequired(consent.getPrivacyOptionsRequirementStatus()
                == ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED);
        if (consent.canRequestAds()) startSdk();
    }

    private void startSdk() {
        if (!sdkStarted.compareAndSet(false, true)) return;
        new Thread(() -> MobileAds.initialize(activity, status -> activity.runOnUiThread(this::load)), "ads-init").start();
    }

    /** Settings → "Privacy & ad choices". */
    void showPrivacyOptions() {
        UserMessagingPlatform.showPrivacyOptionsForm(activity, error -> {
            if (error != null) Log.w(TAG, "Privacy options: " + error.getMessage());
            afterConsent();
        });
    }

    private void load() {
        if (ad != null || loading || !sdkStarted.get() || !consent.canRequestAds()) return;
        if (SystemClock.elapsedRealtime() - lastFailedAt < RETRY_MS) return;
        loading = true;
        InterstitialAd.load(activity, adUnitId, new AdRequest.Builder().build(), new InterstitialAdLoadCallback() {
            @Override public void onAdLoaded(@NonNull InterstitialAd loaded) {
                loading = false;
                ad = loaded;
            }
            @Override public void onAdFailedToLoad(@NonNull LoadAdError error) {
                loading = false;
                lastFailedAt = SystemClock.elapsedRealtime();
                Log.i(TAG, "Interstitial not loaded: " + error.getCode() + " " + error.getMessage());
            }
        });
    }

    /** The player died. Shows the ad if one is ready and the cooldown allows; otherwise makes sure one is loading. */
    void onPlayerDied() {
        long now = SystemClock.elapsedRealtime();
        boolean due = now - startedAt >= FIRST_AD_DELAY_MS && (lastShownAt == 0 || now - lastShownAt >= COOLDOWN_MS);
        if (!due || showing || activity.isFinishing()) { load(); return; }
        InterstitialAd current = ad;
        if (current == null) { load(); return; }
        ad = null;
        current.setFullScreenContentCallback(new FullScreenContentCallback() {
            @Override public void onAdShowedFullScreenContent() { lastShownAt = SystemClock.elapsedRealtime(); }
            @Override public void onAdDismissedFullScreenContent() { finished(); }
            @Override public void onAdFailedToShowFullScreenContent(@NonNull AdError error) {
                Log.w(TAG, "Interstitial not shown: " + error.getMessage());
                finished();
            }
        });
        showing = true;
        listener.onAdShowing(true);
        current.show(activity);
    }

    boolean isShowing() { return showing; }

    private void finished() {
        showing = false;
        listener.onAdShowing(false);
        load();
    }
}
