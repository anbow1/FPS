// One app module, one product flavour per game. Each flavour ships its game's
// production web build (copied into src/<flavour>/assets/game by
// ../build-apks.sh) and shares the WebView activity in src/main.
//
// Signing: set ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD,
// ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD to sign release builds with your
// own key (updates then install over each other). Without them the release
// build is signed with the local debug key: installable, but a build from a
// different machine will not update it in place.

plugins {
    id("com.android.application")
}

val keystoreFile: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() && file(it).exists() }

android {
    namespace = "io.github.anbow1.games"
    compileSdk = 35

    defaultConfig {
        minSdk = 26 // Android 8: WebView with WebGL2 and ES modules everywhere
        targetSdk = 35
        versionCode = (System.getenv("APP_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("APP_VERSION_NAME") ?: "1.0"
    }

    flavorDimensions += "game"
    productFlavors {
        create("fieldLine") {
            dimension = "game"
            applicationId = "io.github.anbow1.fieldline"
        }
        create("castawayLagoon") {
            dimension = "game"
            applicationId = "io.github.anbow1.castawaylagoon"
        }
        create("contrail") {
            dimension = "game"
            applicationId = "io.github.anbow1.contrail"
        }
        create("ridgeline") {
            dimension = "game"
            applicationId = "io.github.anbow1.ridgeline"
        }
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Only a tiny Java activity: nothing worth shrinking, and the game itself is JavaScript.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // WebViewAssetLoader: serves the bundled game over https so ES modules and workers load.
    implementation("androidx.webkit:webkit:1.12.1")
}
