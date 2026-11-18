import java.util.Properties

plugins {
    id("com.android.application")
}

// Release signing comes from keystore.properties (gitignored). See README.md â†’ "Signing".
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// AdMob IDs come from ads.properties (committed: they are not secret). Debug builds always use Google's test IDs,
// so testing never shows (or clicks) real ads. Release builds refuse the test IDs unless -PallowTestAds is passed.
val testAdmobAppId = "ca-app-pub-3940256099942544~3347511713"
val testInterstitialId = "ca-app-pub-3940256099942544/1033173712"
val adsProps = Properties().apply {
    val f = rootProject.file("ads.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val releaseAdmobAppId: String = adsProps.getProperty("admobAppId", "").trim().ifEmpty { testAdmobAppId }
val releaseInterstitialId: String = adsProps.getProperty("interstitialAdUnitId", "").trim().ifEmpty { testInterstitialId }

android {
    namespace = "app.openspadesweb.mobile"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "app.openspadesweb.mobile"
        minSdk = 26          // Android 8.0: adaptive icons; WebView with WebGL 2 + WebAssembly
        targetSdk = 36       // Google Play requirement for new apps and updates in 2026
        versionCode = 1
        versionName = "1.0.0"
        manifestPlaceholders["admobAppId"] = releaseAdmobAppId
        resValue("string", "interstitial_ad_unit_id", releaseInterstitialId)
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
            manifestPlaceholders["admobAppId"] = testAdmobAppId
            resValue("string", "interstitial_ad_unit_id", testInterstitialId)
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

    buildFeatures {
        resValues = true   // interstitial_ad_unit_id
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
    implementation("androidx.fragment:fragment:1.9.1")   // the ads SDK pulls an older one; lint needs >= 1.3 for activity results
    implementation("com.google.android.gms:play-services-ads:25.5.0")
    implementation("com.google.android.ump:user-messaging-platform:4.0.0")
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

// A store build with Google's test ad IDs earns nothing. Fill in ads.properties first (see README â†’ "Ads").
val checkAdIds by tasks.registering {
    doLast {
        if (releaseAdmobAppId == testAdmobAppId || releaseInterstitialId == testInterstitialId)
            throw GradleException("ads.properties still has Google's test AdMob IDs. Fill in admobAppId and interstitialAdUnitId, or pass -PallowTestAds for a test release build.")
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    if (!project.hasProperty("allowTestAds")) dependsOn(checkAdIds)
}
