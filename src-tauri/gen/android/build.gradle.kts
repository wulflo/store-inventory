import com.android.build.api.dsl.LibraryExtension

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.10")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// `tauri-plugin-android-fs` 2.0.1 publica su proyecto Android con
// compileSdk 34, pero `:tauri-android` de Tauri 2.12 exige compilar contra 36.
// Forzamos el compileSdk del plugin después de evaluarlo para que el AAR
// metadata check no rompa el build de release. Sin esto el build local puede
// pasar si el crate cacheado fue parcheado, pero CI falla.
subprojects {
    if (name == "tauri-plugin-android-fs") {
        afterEvaluate {
            extensions.configure<LibraryExtension> {
                compileSdk = 36
            }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}
