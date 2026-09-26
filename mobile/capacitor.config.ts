import type { CapacitorConfig } from '@capacitor/cli';

// NOTE: keep `appName` ASCII ("Izzbah") so Xcode/Gradle project paths stay clean.
// Set the Arabic store/display name ("عزبة") per-platform AFTER you add the
// native projects:
//   - iOS:     ios/App/App/Info.plist  ->  CFBundleDisplayName = عزبة
//   - Android: android/app/src/main/res/values/strings.xml -> app_name = عزبة
const config: CapacitorConfig = {
  appId: 'com.izzbah.game',
  appName: 'Izzbah',
  webDir: 'www',
  // The game ships fully inside the app bundle (index.html is self-contained);
  // it only reaches out to Google Fonts + Firebase over HTTPS at runtime.
  ios: {
    contentInset: 'always',
  },
  android: {
    // allow the embedded base64 / blob images and Firebase to work in the webview
    allowMixedContent: false,
  },
  plugins: {
    // ⚠️ Without this, @capacitor-firebase/authentication loads ZERO native
    // provider handlers (its own default is []) — not just Google
    // misconfigured, but the Google handler object never created at all.
    // That is why signIn() throws "Attempt to invoke virtual method
    // ...GoogleAuthProviderHandler.signIn(...) on a null object reference"
    // rather than a normal auth error. Add "apple.com" here too the day
    // Sign in with Apple is switched on in index.html.
    FirebaseAuthentication: {
      providers: ['google.com'],
    },
  },
};

export default config;
