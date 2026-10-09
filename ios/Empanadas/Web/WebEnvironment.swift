import WebKit

/// How every web view in the app is set up. All of them share the default
/// website data store, so the cookies a sign-in sets in one are there in the
/// rest, and the games keep the same localStorage (the same save) everywhere.
@MainActor
enum WebEnvironment {
    static func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = AppConfig.userAgentSuffix
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.dataDetectorTypes = []
        // The sign-in buttons call window.open() after a fetch, which is no
        // longer inside the tap that started it.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.userContentController.addUserScript(bridgeScript)
        return configuration
    }

    /// Resources/bridge.js, which defines window.empanadasApp on the site's
    /// pages. Main frame only: a third-party iframe never sees it, and
    /// NativeBridge refuses messages from anywhere but the site regardless.
    private static let bridgeScript: WKUserScript = {
        let source: String
        if let url = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let text = try? String(contentsOf: url, encoding: .utf8) {
            source = text.replacingOccurrences(of: "__APP_VERSION__", with: AppConfig.version)
        } else {
            assertionFailure("bridge.js is missing from the app bundle")
            source = ""
        }
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
    }()

    private static var cachedUserAgent: String?
    private static var userAgentProbe: WKWebView?

    /// The user agent the web views send. Native requests to the site must
    /// send the same one: checkSession() on the site ties a session to the
    /// user agent it was started with.
    static func userAgent() async -> String {
        if let cachedUserAgent { return cachedUserAgent }
        let probe = WKWebView(frame: .zero, configuration: makeConfiguration())
        userAgentProbe = probe
        defer { userAgentProbe = nil }
        let agent = (try? await probe.evaluateJavaScript("navigator.userAgent")) as? String
        let result = agent ?? "Mozilla/5.0 (iPhone; CPU iPhone OS like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 \(AppConfig.userAgentSuffix)"
        cachedUserAgent = result
        return result
    }

    /// Empties the caches but keeps cookies and local storage, so the player
    /// stays signed in and keeps their game saves. Same as clearAppCache() in
    /// the desktop app.
    static func clearCache() async {
        let types: Set<String> = [
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
            WKWebsiteDataTypeFetchCache,
            WKWebsiteDataTypeOfflineWebApplicationCache,
        ]
        await WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast)
    }
}
