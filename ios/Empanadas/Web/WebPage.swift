import SwiftUI
import WebKit

/// One web view and everything it is allowed to do. The navigation rules are
/// the desktop app's (main.js, 'web-contents-created'), with native screens
/// standing in for the site's own navigation.
@MainActor
@Observable
final class WebPage: NSObject, Identifiable {
    struct Options {
        /// Taps on links to pages the app shows natively (the dashboard, the
        /// account page, the games) open those screens instead.
        var interceptsRoutes = true
        /// The screen this page already is, so its own links load in place.
        var ownRoute: NativeRoute?
        var pullToRefresh = true
    }

    enum Kind {
        case main(Options)
        /// A window the site opened: a sign-in, 2FA or captcha step. No
        /// bridge, and limited to the site, the providers and the SSO hosts.
        case popup
    }

    let id = UUID()
    let kind: Kind
    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored weak var app: AppModel?
    /// For a popup, the page that opened it.
    @ObservationIgnored weak var opener: WebPage?
    @ObservationIgnored private var bridge: NativeBridge?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var lastRequestedURL: URL?

    private(set) var title = ""
    private(set) var isLoading = false
    private(set) var canGoBack = false
    private(set) var hasLoaded = false
    private(set) var loadError: Error?

    /// A page of the app's own, with the bridge.
    init(url: URL?, options: Options = Options(), app: AppModel) {
        kind = .main(options)
        let configuration = WebEnvironment.makeConfiguration()
        let bridge = NativeBridge()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.name)
        webView = WKWebView(frame: .zero, configuration: configuration)
        self.bridge = bridge
        self.app = app
        super.init()
        bridge.page = self
        setUp(pullToRefresh: options.pullToRefresh)
        if let url { load(url) }
    }

    /// A window the site opened. WebKit decides the configuration; it must be
    /// used as given.
    init(popupWith configuration: WKWebViewConfiguration, app: AppModel) {
        kind = .popup
        webView = WKWebView(frame: .zero, configuration: configuration)
        self.app = app
        super.init()
        setUp(pullToRefresh: false)
    }

    var isPopup: Bool {
        if case .popup = kind { return true }
        return false
    }

    private var options: Options? {
        if case .main(let options) = kind { return options }
        return nil
    }

    private func setUp(pullToRefresh: Bool) {
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "Brand")
        #if DEBUG
        webView.isInspectable = true
        #endif

        if pullToRefresh {
            let refresh = UIRefreshControl()
            refresh.tintColor = .white
            refresh.addTarget(self, action: #selector(pulledToRefresh(_:)), for: .valueChanged)
            webView.scrollView.refreshControl = refresh
        }

        observations = [
            webView.observe(\.title) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.title = webView.title ?? "" }
            },
            webView.observe(\.isLoading) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.isLoading = webView.isLoading }
            },
            webView.observe(\.canGoBack) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.canGoBack = webView.canGoBack }
            },
        ]
    }

    // MARK: - Loading

    func load(_ url: URL) {
        lastRequestedURL = url
        loadError = nil
        webView.load(URLRequest(url: url))
    }

    func reload() {
        loadError = nil
        if webView.url == nil, let lastRequestedURL {
            webView.load(URLRequest(url: lastRequestedURL))
        } else {
            webView.reload()
        }
    }

    func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    @objc private func pulledToRefresh(_ sender: UIRefreshControl) {
        reload()
        sender.endRefreshing()
    }

    /// Runs a script in the page, ignoring the result. Only for scripts the
    /// app wrote itself.
    func run(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private func handle(_ error: Error) {
        let error = error as NSError
        // A navigation this page cancelled itself, or replaced with another.
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == WKError.errorDomain && error.code == WKError.frameLoadInterruptedByPolicyChange.rawValue { return }
        if error.domain == NSURLErrorDomain, let failing = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
            lastRequestedURL = failing
        }
        loadError = error
    }

    // MARK: - Navigation rules

    /// Subframes (ads, Cloudflare's captcha) may load anything over https.
    /// They never get the bridge: it is main-frame only, and NativeBridge
    /// checks the frame of every message.
    private static func allowsSubframe(_ url: URL) -> Bool {
        ["https", "about", "blob", "data"].contains(url.scheme?.lowercased() ?? "")
    }

    private func mainPolicy(_ url: URL, _ action: WKNavigationAction, _ options: Options) -> WKNavigationActionPolicy {
        guard let app else { return .cancel }
        if url.scheme == "about" { return .allow }

        if SiteURLs.isBrowserSignInURL(url) {
            app.startBrowserSignIn(url, from: self)
            return .cancel
        }

        if SiteURLs.isAppURL(url) {
            if options.interceptsRoutes, action.navigationType == .linkActivated,
               let route = NativeRoute.of(url), route != options.ownRoute {
                app.navigate(to: route)
                return .cancel
            }
            if SiteURLs.isPath(url, in: SiteURLs.logoutPaths) {
                app.observe(.signedOut)
            }
            return .allow
        }

        // A provider page the site redirected to (an older sign-in flow, or
        // linking an account): give it a popup, never this page.
        if SiteURLs.isAuthURL(url), action.navigationType != .linkActivated {
            app.openPopup(url)
            return .cancel
        }

        // Anything else leaves the app. The SSO roundabout hosts do not: they
        // only exist to sign the player in to a browser, and there is none.
        if !SiteURLs.isSSOURL(url) {
            app.openExternally(url)
        }
        return .cancel
    }

    private func popupPolicy(_ url: URL) -> WKNavigationActionPolicy {
        guard let app else { return .cancel }
        if url.scheme == "about" { return .allow }

        if SiteURLs.isBrowserSignInURL(url) {
            app.startBrowserSignIn(url, from: self)
            app.dismissPopup(self)
            return .cancel
        }

        if !SiteURLs.isPopupURL(url) {
            app.openExternally(url)
            if webView.url == nil || webView.url?.scheme == "about" {
                app.dismissPopup(self)
            }
            return .cancel
        }

        // The sign-in is over: the page belongs in the app, not the popup.
        if SiteURLs.isHandoffURL(url) {
            app.handOff(url)
            app.dismissPopup(self)
            return .cancel
        }
        return .allow
    }
}

// MARK: - WKNavigationDelegate

extension WebPage: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        // No target frame: a new window. createWebViewWith decides those.
        guard let frame = navigationAction.targetFrame else { return .allow }
        guard frame.isMainFrame else { return Self.allowsSubframe(url) ? .allow : .cancel }

        switch kind {
        case .main(let options): return mainPolicy(url, navigationAction, options)
        case .popup: return popupPolicy(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if let response = navigationResponse.response as? HTTPURLResponse, let url = response.url,
           let signal = SignInSignal.of(responseURL: url, statusCode: response.statusCode,
                                        isMainFrame: navigationResponse.isForMainFrame) {
            app?.observe(signal)
        }
        return .allow
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loadError = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoaded = true
        loadError = nil
        if case .main = kind, let url = webView.url, SiteURLs.isAppURL(url) {
            app?.pageDidLoad(self)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handle(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handle(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }
}

// MARK: - WKUIDelegate

extension WebPage: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let app, let url = navigationAction.request.url, url.scheme != "about" else { return nil }

        // Only the site gets to open windows, and a popup cannot open another.
        let fromSite = !isPopup && (webView.url.map(SiteURLs.isAppURL) ?? false)

        if fromSite && SiteURLs.isBrowserSignInURL(url) {
            app.startBrowserSignIn(url, from: self)
            return nil
        }

        // core.js signs out through a popup of /v2/auth/logout.php. Run it
        // out of sight rather than flashing a sheet.
        if fromSite && SiteURLs.isPath(url, in: SiteURLs.logoutPaths) {
            let page = WebPage(popupWith: configuration, app: app)
            page.opener = self
            app.runInBackground(page)
            app.observe(.signedOut)
            return page.webView
        }

        // A sign-in window: a provider, or a script-opened page of the site's.
        if fromSite && (SiteURLs.isAuthURL(url) || (SiteURLs.isAppURL(url) && navigationAction.navigationType != .linkActivated)) {
            let page = WebPage(popupWith: configuration, app: app)
            page.opener = self
            app.presentPopup(page)
            return page.webView
        }

        // A target="_blank" link to the site: follow it here, or natively.
        if fromSite && SiteURLs.isAppURL(url) {
            if let options, options.interceptsRoutes, let route = NativeRoute.of(url), route != options.ownRoute {
                app.navigate(to: route)
            } else {
                load(url)
            }
            return nil
        }

        if !SiteURLs.isAppURL(url) {
            app.openExternally(url)
        }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) {
        app?.dismissPopup(self)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        await Dialogs.alert(message)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await Dialogs.confirm(message)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        await Dialogs.prompt(prompt, defaultText: defaultText)
    }

    // Same as the desktop app's lockDownPermissions(): the site needs no
    // camera or microphone, so nothing gets one.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }
}
