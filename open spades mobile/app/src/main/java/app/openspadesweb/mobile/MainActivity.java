// OpenSpades Mobile — hosts the WebAssembly game in a WebView. GPL-3.0-or-later.
package app.openspadesweb.mobile;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends ComponentActivity {
    private static final String TAG = "OpenSpades";
    /** Game files are served from APK assets on this secure, app-private origin (no file:// access). */
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final String START_URL = ORIGIN + "/index.html";

    private WebView webView;
    private JavaScriptReplyProxy jsPort;
    private UdpBridge udp;
    private Insets lastInsets = Insets.NONE;
    private byte[] pendingSave;
    private ActivityResultLauncher<Intent> saveLauncher;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        hideSystemBars();

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showFatal(getString(R.string.webview_too_old));
            return;
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        root.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // settings live in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);    // Web Audio sound effects
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);                              // system font scaling would break the HUD layout
        s.setOffscreenPreRaster(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);       // assets come from the APK; never serve stale ones after an update
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/", new GamePathHandler(getAssets()))
                .build();
        webView.setWebViewClient(new GameClient(loader));

        udp = new UdpBridge(this::postToJs);
        WebViewCompat.addWebMessageListener(webView, "OpenSpadesNative", Collections.singleton(ORIGIN),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame) return;
                    jsPort = replyProxy;
                    String data = message.getData();
                    if (data != null) onJsMessage(data);
                });

        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            // Hidden system bars report zero; cutouts and the gesture area stay as safe-area padding for the UI.
            Insets safe = Insets.max(insets.getInsets(WindowInsetsCompat.Type.displayCutout()),
                    insets.getInsets(WindowInsetsCompat.Type.systemBars()));
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            // Shrink the page above the on-screen keyboard so dialogs with text fields stay visible.
            v.setPadding(0, 0, 0, Math.max(0, ime.bottom - safe.bottom));
            lastInsets = safe;
            sendInsets();
            return WindowInsetsCompat.CONSUMED;
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (jsPort != null) postToJs("{\"op\":\"back\"}");
                else moveTaskToBack(true);
            }
        });

        saveLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            byte[] bytes = pendingSave; pendingSave = null;
            Uri uri = result.getData() != null ? result.getData().getData() : null;
            if (result.getResultCode() != RESULT_OK || uri == null || bytes == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("No output stream");
                out.write(bytes);
                Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
            } catch (IOException e) {
                Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
            }
        });

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        if (webView.getUrl() == null) webView.loadUrl(START_URL);
    }

    // ---------- JS ⇄ native messages ----------

    private void postToJs(String json) {
        if (jsPort != null) jsPort.postMessage(json);
    }

    private void onJsMessage(String data) {
        JSONObject m;
        try { m = new JSONObject(data); } catch (JSONException e) { return; }
        switch (m.optString("op")) {
            case "ready": sendInsets(); break;
            case "udp": udp.handle(m); break;
            case "haptic": haptic(m.optString("kind")); break;
            case "gameActive": setKeepScreenOn(m.optBoolean("on")); break;
            case "keepAwake": setKeepScreenOn(m.optBoolean("on")); break;
            case "save": save(m.optString("name", "OpenSpades"), m.optString("mime", "application/octet-stream"), m.optString("data")); break;
            case "open": openExternal(m.optString("url")); break;
            case "exit": moveTaskToBack(true); break;
            default: break;
        }
    }

    private void sendInsets() {
        if (jsPort == null || webView == null) return;
        float d = getResources().getDisplayMetrics().density;
        try {
            postToJs(new JSONObject().put("op", "insets")
                    .put("top", lastInsets.top / d).put("right", lastInsets.right / d)
                    .put("bottom", lastInsets.bottom / d).put("left", lastInsets.left / d).toString());
        } catch (JSONException ignored) { }
    }

    private void haptic(String kind) {
        if (webView == null) return;
        int c;
        switch (kind) {
            case "hit": c = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY; break;
            case "hurt": c = HapticFeedbackConstants.LONG_PRESS; break;
            case "heavy": c = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS; break;
            default: c = HapticFeedbackConstants.KEYBOARD_TAP; break;
        }
        webView.performHapticFeedback(c);
    }

    private void setKeepScreenOn(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** Screenshots and .vxl maps: the user picks where to save with the system file picker (no storage permission). */
    private void save(String name, String mime, String base64) {
        try { pendingSave = Base64.decode(base64, Base64.NO_WRAP); } catch (IllegalArgumentException e) { return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime)
                .putExtra(Intent.EXTRA_TITLE, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
        try { saveLauncher.launch(intent); }
        catch (ActivityNotFoundException e) { pendingSave = null; Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show(); }
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) { }
    }

    // ---------- Lifecycle ----------

    private void hideSystemBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override protected void onPause() {
        postToJs("{\"op\":\"lifecycle\",\"state\":\"pause\"}");
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        postToJs("{\"op\":\"lifecycle\",\"state\":\"resume\"}");
        hideSystemBars();
    }

    @Override protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override protected void onDestroy() {
        if (udp != null) udp.closeAll();
        if (webView != null) {
            webView.stopLoading();
            ((FrameLayout) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void showFatal(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setBackgroundColor(Color.BLACK);
        t.setTextSize(18);
        int p = (int) (32 * getResources().getDisplayMetrics().density);
        t.setPadding(p, p, p, p);
        setContentView(t);
    }

    // ---------- Asset server ----------

    private final class GameClient extends WebViewClientCompat {
        private final WebViewAssetLoader loader;
        GameClient(WebViewAssetLoader loader) { this.loader = loader; }

        @Override public WebResourceResponse shouldInterceptRequest(@NonNull WebView view, @NonNull WebResourceRequest request) {
            return loader.shouldInterceptRequest(request.getUrl());
        }

        @Override public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
            Uri url = request.getUrl();
            if (HOST.equals(url.getHost())) return false;
            openExternal(url.toString());   // links to the web open in the user's browser
            return true;
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer was killed (usually low memory). Rebuild the activity instead of crashing the app.
            Log.w(TAG, "WebView renderer gone; crashed=" + detail.didCrash());
            if (webView == view) {
                ((FrameLayout) view.getParent()).removeView(view);
                view.destroy();
                webView = null;
                jsPort = null;
            }
            recreate();
            return true;
        }
    }

    /** Serves files from APK assets with correct MIME types (WebAssembly streaming needs application/wasm). */
    private static final class GamePathHandler implements WebViewAssetLoader.PathHandler {
        private static final Map<String, String> TYPES = new HashMap<>();
        static {
            TYPES.put("html", "text/html"); TYPES.put("js", "text/javascript"); TYPES.put("mjs", "text/javascript");
            TYPES.put("css", "text/css"); TYPES.put("wasm", "application/wasm"); TYPES.put("json", "application/json");
            TYPES.put("png", "image/png"); TYPES.put("jpg", "image/jpeg"); TYPES.put("svg", "image/svg+xml");
            TYPES.put("opus", "audio/ogg"); TYPES.put("ogg", "audio/ogg"); TYPES.put("wav", "audio/wav");
            TYPES.put("ttf", "font/ttf"); TYPES.put("txt", "text/plain"); TYPES.put("md", "text/plain");
        }
        private final AssetManager assets;
        GamePathHandler(AssetManager assets) { this.assets = assets; }

        @Override public WebResourceResponse handle(@NonNull String path) {
            if (path.isEmpty() || path.endsWith("/")) path += "index.html";
            if (path.contains("..")) return notFound();
            String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
            String mime = TYPES.containsKey(ext) ? TYPES.get(ext) : "application/octet-stream";
            boolean text = mime.startsWith("text/") || mime.equals("application/json");
            try {
                InputStream in = assets.open(path, AssetManager.ACCESS_STREAMING);
                WebResourceResponse r = new WebResourceResponse(mime, text ? "utf-8" : null, in);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                headers.put("X-Content-Type-Options", "nosniff");
                r.setResponseHeaders(headers);
                return r;
            } catch (IOException e) {
                return notFound();
            }
        }

        private static WebResourceResponse notFound() {
            WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
            r.setStatusCodeAndReasonPhrase(404, "Not Found");
            return r;
        }
    }
}
