import Foundation

enum AppConfig {
    static let urlScheme = "empanadas-io"

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    }

    /// Appended to WebKit's user agent. The site tells the iOS app apart from
    /// a browser by this token (see ios/SITE-CHANGES.md).
    ///
    /// It must NOT look like "Empanadas.io/1.2.3": the site reads that as the
    /// desktop app and checks it against the desktop release on GitHub, which
    /// would send this app to /appoutofdate.html. "native-app" makes the login
    /// page skip its browser version check, as it already does for the
    /// desktop app.
    static var userAgentSuffix: String {
        "EmpanadasiOS/\(version) native-app"
    }

    /// How long a browser sign-in may take before a returning
    /// empanadas-io://auth link is ignored. Matches APP_AUTH_TTL on the site.
    static let browserSignInTTL: TimeInterval = 10 * 60
}
