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
        /// Without a connection, load from the copy WebKit's cache already
        /// has (the games: static pages that keep their saves on the device).
        var loadsFromCacheOffline = false
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
    /// Where the page is now, pushState included.
    private(set) var url: URL?
    /// The page it first arrived at, after any redirects.
    @ObservationIgnored private var firstURL: URL?
    /// The page drew its own way out of the game player (an element marked
    /// data-app-close, reported by Resources/bridge.js), so the player
    /// leaves its native close button off.
    private(set) var drawsOwnCloseButton = false
    private(set) var isLoading = false
    private(set) var canGoBack = false
    private(set) var hasLoaded = false
    private(set) var loadError: Error?
    /// The page's background colour, as it reported it. What the space around
    /// the page is painted, rather than a fixed colour.
    private(set) var pageColor: UIColor?
    /// Showing the copy from WebKit's cache because there was no connection.
    private(set) var isOfflineCopy = false
    /// The cached copy was tried too, and there was none.
    private(set) var offlineCopyMissing = false
    @ObservationIgnored private var triedCache = false

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

    /// The native screen this page is, if any.
    var ownRoute: NativeRoute? { options?.ownRoute }

    private func setUp(pullToRefresh: Bool) {
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        #if DEBUG
        webView.isInspectable = true
        #endif

        if pullToRefresh {
            let refresh = UIRefreshControl()
            refresh.tintColor = .secondaryLabel
            refresh.addTarget(self, action: #selector(pulledToRefresh(_:)), for: .valueChanged)
            webView.scrollView.refreshControl = refresh
        }

        observations = [
            webView.observe(\.title) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.title = webView.title ?? "" }
            },
            webView.observe(\.url) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.url = webView.url }
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
        triedCache = false
        offlineCopyMissing = false
        if prefersCache {
            loadFromCache(url)
        } else {
            isOfflineCopy = false
            webView.load(URLRequest(url: url))
        }
    }

    func reload() {
        loadError = nil
        triedCache = false
        offlineCopyMissing = false
        if prefersCache, let url = lastRequestedURL ?? webView.url {
            loadFromCache(url)
        } else if webView.url == nil || isOfflineCopy, let url = lastRequestedURL ?? webView.url {
            // A copy from the cache, or nothing at all: go to the site.
            isOfflineCopy = false
            webView.load(URLRequest(url: url))
        } else {
            webView.reload()
        }
    }

    /// The page's background, from the bridge. Painted behind and around the
    /// page: the safe areas, the overscroll, the gap before it draws.
    func setPageColor(_ color: UIColor) {
        guard color != pageColor else { return }
        pageColor = color
        webView.backgroundColor = color
        webView.scrollView.backgroundColor = color
        webView.underPageBackgroundColor = color
    }

    private var prefersCache: Bool {
        (options?.loadsFromCacheOffline ?? false) && app?.isOnline == false
    }

    /// Loads whatever WebKit's cache has for the page, however old: the page
    /// and, while it loads, everything it asks for. A page that was never
    /// opened online has nothing there, and fails as before.
    private func loadFromCache(_ url: URL) {
        triedCache = true
        isOfflineCopy = true
        webView.load(URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad))
    }

    /// Errors that mean "no way to the site", as opposed to one it gave.
    nonisolated static func isConnectionError(_ error: Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        return [
            NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorCannotFindHost,
            NSURLErrorCannotConnectToHost, NSURLErrorTimedOut, NSURLErrorDNSLookupFailed,
            NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed, NSURLErrorCallIsActive,
        ].contains(error.code)
    }

    /// Still on the page it was opened with. A title the screen gave it only
    /// fits that page: a profile opened as "pal" is someone else's profile
    /// once a link on it is followed.
    var isOnFirstPage: Bool {
        guard let firstURL, let url else { return true }
        return url.host() == firstURL.host() && SiteURLs.normalizedPath(url) == SiteURLs.normalizedPath(firstURL)
    }

    func ownsCloseButton() {
        drawsOwnCloseButton = true
    }

    func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    @objc private func pulledToRefresh(_ sender: UIRefreshControl) {
        reload()
        sender.endRefreshing()
    }

    /// WebKitErrorFrameLoadInterruptedByPolicyChange: a navigation the policy
    /// delegate cancelled. Only defined in WebKit's C headers, not in WKError.
    private static let frameLoadInterruptedByPolicyChange = 102

    private func handle(_ error: Error) {
        let error = error as NSError
        // A navigation this page cancelled itself, or replaced with another.
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain" && error.code == Self.frameLoadInterruptedByPolicyChange { return }
        if error.domain == NSURLErrorDomain, let failing = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
            lastRequestedURL = failing
        }
        // No connection: a game can still start from the copy in the cache.
        if options?.loadsFromCacheOffline == true, Self.isConnectionError(error), let url = lastRequestedURL {
            if !triedCache {
                loadFromCache(url)
                return
            }
            offlineCopyMissing = true
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
            // A game leaving for the homepage or the dashboard, by script as
            // much as by link: its own close button does that. Close the
            // player rather than load the site's homepage inside it.
            if case .game? = options.ownRoute, SiteURLs.isGameExitURL(url) {
                app.closeGame()
                return .cancel
            }
            if SiteURLs.isPath(url, in: SiteURLs.logoutPaths) {
                app.observe(.signedOut)
                return .allow
            }
            // A link from a game to another page of the site: over the game.
            if opensOverGame(url, options), action.navigationType == .linkActivated {
                app.openOverGame(url)
                return .cancel
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

    /// A page of the site a game links to that is not a game (Spin's account
    /// button and Report a Problem). Shown over the game rather than in its
    /// place, where the player has no way back to it.
    private func opensOverGame(_ url: URL, _ options: Options) -> Bool {
        guard case .game? = options.ownRoute else { return false }
        return Game.of(url) == nil && !SiteURLs.isGameExitURL(url) && !SiteURLs.isPath(url, in: SiteURLs.logoutPaths)
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

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if firstURL == nil { firstURL = webView.url }
        // A new document: it says again whether it has a close button.
        drawsOwnCloseButton = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoaded = true
        loadError = nil
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

        // A target="_blank" link to the site: follow it here, natively, or
        // over the game.
        if fromSite && SiteURLs.isAppURL(url) {
            if let options, options.interceptsRoutes, let route = NativeRoute.of(url), route != options.ownRoute {
                app.navigate(to: route)
            } else if let options, opensOverGame(url, options) {
                app.openOverGame(url)
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
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                 initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }
}
