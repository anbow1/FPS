package io.github.anbow1.games;

import android.app.Activity;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Full-screen, landscape host for one bundled web game. The game's production
 * build lives in assets/game and is served from a virtual https origin by
 * WebViewAssetLoader, so ES modules, fetch and localStorage behave exactly as
 * on a web server (file:// would block module scripts). Everything runs
 * offline; the app needs no permissions.
 */
public class GameActivity extends Activity {

    private static final String ENTRY = "https://" + WebViewAssetLoader.DEFAULT_DOMAIN + "/assets/game/index.html";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // settings and key bindings persist in localStorage
        s.setMediaPlaybackRequiresUserGesture(false); // Web Audio starts on the first tap anyway
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Stay inside the bundled game; there is nothing else to navigate to.
                Uri url = request.getUrl();
                return !WebViewAssetLoader.DEFAULT_DOMAIN.equals(url.getHost());
            }
        });
        // The games' "Quit game" buttons call AndroidApp.quit(); only the bundled game is ever loaded.
        web.addJavascriptInterface(new AppBridge(), "AndroidApp");
        setContentView(web);
        hideSystemBars();
        if (savedInstanceState == null) web.loadUrl(ENTRY);
        else web.restoreState(savedInstanceState);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    /** Back pauses the game if it is being played (ui/touch.ts sets window.__gamePause); otherwise it leaves. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.__gamePause && window.__gamePause()) === true", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onPause() {
        // Pause the game first so switching apps never leaves it running blind, then stop timers and audio.
        web.evaluateJavascript("window.__gamePause && window.__gamePause()", null);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    /** What the page may ask of the app. */
    private final class AppBridge {
        /** Ends the game: closes the activity and drops it from the recent apps. */
        @JavascriptInterface
        public void quit() {
            runOnUiThread(GameActivity.this::finishAndRemoveTask);
        }
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
