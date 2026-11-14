// OpenSpades Helper for Android: the same WebSocket-to-UDP relay as ../helper (the desktop helper), in a foreground
// service, for Chrome or Firefox on the phone. No libraries beyond the Android framework.
//
// Build: ./gradlew assembleRelease (JDK 17+, Android SDK platform 36).
//   OSHELPER_ORIGINS   comma-separated page origins allowed to use the helper (compiled in, as for the desktop helper);
//                      http://127.0.0.1 and http://localhost pages are always allowed
//   OSHELPER_KEYSTORE, OSHELPER_KEYSTORE_PASSWORD, OSHELPER_KEY_ALIAS, OSHELPER_KEY_PASSWORD
//                      release signing; without them the release APK is unsigned (debug builds use the debug key)
plugins {
    id("com.android.application")
}

val origins = System.getenv("OSHELPER_ORIGINS") ?: ""
val keystore = System.getenv("OSHELPER_KEYSTORE")

android {
    namespace = "io.github.sgtmetz.openspadeshelper"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.sgtmetz.openspadeshelper"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "ORIGINS", "\"" + origins.replace("\\", "").replace("\"", "") + "\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("OSHELPER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("OSHELPER_KEY_ALIAS")
                keyPassword = System.getenv("OSHELPER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
