import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing comes from keystore.properties (gitignored). See README.md â†’ "Signing".
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}


android {
    namespace = "app.openspadesweb.mobile"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "app.openspadesweb.mobile"
        minSdk = 26          // Android 8.0: adaptive icons; WebView with WebGL 2 + WebAssembly
        targetSdk = 36       // Google Play requirement for new apps and updates in 2026
        versionCode = 2
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystoreProps.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    // The game (HTML/JS/WebAssembly/media) lives in ../web and is packaged as APK assets.
    sourceSets {
        getByName("main") {
            assets.srcDir(rootProject.file("web"))
        }
    }

    androidResources {
        // Already-compressed media gains nothing from zip compression; leave it stored for faster loads.
        noCompress += listOf("opus", "png", "jpg")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    bundle {
        language { enableSplit = false }
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.core:core:1.19.1")
    implementation("androidx.webkit:webkit:1.18.0")
}

// Fail early with a clear message if the engine/media have not been copied into web/ yet.
val checkWebAssets by tasks.registering {
    doLast {
        val web = rootProject.file("web")
        val required = listOf("index.html", "main.js", "engine/openspades.wasm", "engine/openspades.js", "vendor/three.module.js", "assets/manifest.json")
        val missing = required.filter { !web.resolve(it).exists() }
        if (missing.isNotEmpty()) throw GradleException("Missing web files: $missing. Run: node scripts/sync-web.mjs")
    }
}
tasks.named("preBuild") { dependsOn(checkWebAssets) }
