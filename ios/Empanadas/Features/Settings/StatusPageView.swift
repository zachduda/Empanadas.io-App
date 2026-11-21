import SwiftUI
import WebKit

/// The full status page, in a sheet that looks like the rest of the app
/// rather than a browser: the app's own title bar with Done (and Back, once
/// a link has been followed), no address, the page's own header and
/// "Powered by" line left out, the system font, and no zooming, selecting
/// or link previews. Nor any way off it: links stay on the status page
/// (an incident, the history), and anything else goes nowhere.
///
/// The page is Statuspage's, not the site's, so it is kept apart from the
/// app's own web views (WebEnvironment): no bridge, none of the site's
/// cookies, and nothing it stores outlives the sheet.
struct StatusPageView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    /// Made once the sheet is up, and once only: as @State's initial value
    /// it would be made (web view and all) every time the view was.
    @State private var page: StatusPage?

    var body: some View {
        NavigationStack {
            ZStack {
                Color(uiColor: page?.backgroundColor ?? .systemBackground)
                    .ignoresSafeArea()
                if let page {
                    WebViewContainer(webView: page.webView)
                        // Out of sight until it has drawn and said what
                        // colour it is, so the bars and the space around it
                        // change with it rather than after it.
                        .opacity(page.hasContent && page.loadError == nil ? 1 : 0)
                }
                if let page, page.loadError != nil {
                    failure(page)
                } else if page?.hasContent != true {
                    ProgressView()
                        .controlSize(.large)
                        // Drawn for what it is on: light on the page's blue.
                        .environment(\.colorScheme, page?.colorScheme ?? colorScheme)
                }
            }
            .animation(.easeOut(duration: 0.25), value: page?.hasContent)
            .animation(.easeOut(duration: 0.25), value: page?.backgroundColor)
            .navigationTitle("Server Status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if page?.canGoBack == true {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            page?.goBack()
                        } label: {
                            Label("Back", systemImage: "chevron.backward")
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .modifier(StatusPageBars(page: page))
        }
        .onAppear {
            if page == nil { page = StatusPage() }
        }
        // Back online: load what could not be, rather than wait for a tap.
        .onChange(of: model.isOnline) { _, online in
            if online, let page, page.loadError != nil { page.reload() }
        }
    }

    private func failure(_ page: StatusPage) -> ConnectionErrorView {
        if !model.isOnline {
            return ConnectionErrorView(
                title: "You're Offline",
                message: "The status page will load once you're back online.",
                systemImage: "wifi.slash"
            ) { page.reload() }
        }
        return ConnectionErrorView(
            title: "Couldn't Load the Status Page",
            message: "Check your connection and try again.",
            systemImage: "wifi.exclamationmark"
        ) { page.reload() }
    }
}

/// The bars over the page, as pageBars does for the site's: where the page
/// is light and the app dark, or the other way round, the navigation bar
/// takes the page's colour and its light or dark, so its title and buttons
/// stay readable. Where the two agree, the system's own bar.
private struct StatusPageBars: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let page: StatusPage?

    func body(content: Content) -> some View {
        let pageScheme = page?.colorScheme
        // Nil while the page agrees with the app, or has not said yet.
        let scheme = pageScheme == colorScheme ? nil : pageScheme
        return content
            .toolbarBackground(Color(uiColor: page?.backgroundColor ?? .systemBackground), for: .navigationBar)
            .toolbarBackground(scheme == nil ? Visibility.automatic : .visible, for: .navigationBar)
            .toolbarColorScheme(scheme, for: .navigationBar)
    }
}

/// The status page's web view, and the little it is allowed to do.
@MainActor
@Observable
final class StatusPage: NSObject {
    @ObservationIgnored let webView: WKWebView

    /// The page has drawn: when the spinner gives way to it.
    private(set) var hasContent = false
    private(set) var canGoBack = false
    private(set) var loadError: Error?
    /// The page's background, as it drew it. What the space around it and
    /// the bar over it are painted.
    private(set) var backgroundColor: UIColor?
    /// Whether that is light or dark.
    private(set) var colorScheme: ColorScheme?

    /// The host the page settled on: the status page's own, or wherever
    /// that redirected on the way in (a custom domain, should it get one).
    /// Nothing is followed anywhere else.
    @ObservationIgnored private var host: String?
    @ObservationIgnored private var observation: NSKeyValueObservation?

    /// How long the page may take to start answering.
    private static let timeout: TimeInterval = 20

    override init() {
        let configuration = WKWebViewConfiguration()
        // Nothing of the site's, and nothing kept.
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addUserScript(Self.nativeLook)
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        // Back through the status page's own pages, as on a pushed screen.
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.bouncesZoom = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        #if DEBUG
        webView.isInspectable = true
        #endif

        let refresh = UIRefreshControl()
        refresh.tintColor = .secondaryLabel
        refresh.addTarget(self, action: #selector(pulledToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        observation = webView.observe(\.canGoBack) { [weak self] webView, _ in
            MainActor.assumeIsolated { self?.canGoBack = webView.canGoBack }
        }
        // The colour it was last time (the page's own blue), so the sheet
        // opens in it rather than in white and changes once the page draws.
        if let saved = UserDefaults.standard.string(forKey: Preferences.statusPageColorKey) {
            paint(saved)
        }
        load()
    }

    func reload() {
        loadError = nil
        if webView.url == nil {
            load()
        } else {
            webView.reload()
        }
    }

    func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    private func load() {
        loadError = nil
        webView.load(URLRequest(url: ServerStatus.page, timeoutInterval: Self.timeout))
    }

    @objc private func pulledToRefresh(_ sender: UIRefreshControl) {
        reload()
        // Until the page has answered, and no longer than it may take.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(StatusPage.timeout))
            self?.endRefreshing()
        }
    }

    private func endRefreshing() {
        guard let refresh = webView.scrollView.refreshControl, refresh.isRefreshing else { return }
        refresh.endRefreshing()
    }

    /// Shows the page, in its own colours.
    private func reveal() async {
        await readBackground()
        hasContent = true
    }

    /// The page's background: the body's, or the document's if that is
    /// see-through, or the browser's white if both are. Kept for next time.
    private func readBackground() async {
        let script = """
        [document.body, document.documentElement].filter(Boolean)
            .map(function (element) { return getComputedStyle(element).backgroundColor; }).join('|')
        """
        guard let answer = (try? await webView.evaluateJavaScript(script)) as? String else { return }
        let found = answer.split(separator: "|").map(String.init).first { part in
            guard let color = CSSColor(part) else { return false }
            return !color.isTransparent
        }
        let css = found ?? "rgb(255, 255, 255)"
        UserDefaults.standard.set(css, forKey: Preferences.statusPageColorKey)
        paint(css)
    }

    /// The space around the page, the bar over it and the overscroll, in
    /// its colour.
    private func paint(_ css: String) {
        guard let parsed = CSSColor(css), !parsed.isTransparent else { return }
        let color = UIColor(red: parsed.red, green: parsed.green, blue: parsed.blue, alpha: 1)
        guard color != backgroundColor else { return }
        backgroundColor = color
        colorScheme = parsed.isDark ? .dark : .light
        webView.underPageBackgroundColor = color
    }

    // MARK: - Where it may go

    /// The status page's own pages, over https. Before it has drawn
    /// anything, wherever its first load is redirected (nothing on it can
    /// have been tapped yet).
    private func allows(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let target = url.host()?.lowercased() else { return false }
        guard let host else { return true }
        return target == host || target == ServerStatus.page.host()?.lowercased()
    }

    /// Subframes (an embedded chart, a captcha) may load anything over
    /// https. None of them gets anything of the app's.
    private static func allowsSubframe(_ url: URL) -> Bool {
        ["https", "about", "blob", "data"].contains(url.scheme?.lowercased() ?? "")
    }

    /// WebKitErrorFrameLoadInterruptedByPolicyChange: a navigation this page
    /// refused (decidePolicyFor). Only defined in WebKit's C headers.
    private static let frameLoadInterruptedByPolicyChange = 102

    private func handle(_ error: Error) {
        endRefreshing()
        let error = error as NSError
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain" && error.code == Self.frameLoadInterruptedByPolicyChange { return }
        loadError = error
    }

    // MARK: - Looking native

    /// Put in before the page's own styles, so they apply from the first
    /// paint. The class names are Statuspage's hosted-page markup; one that
    /// is not there changes nothing.
    private static let nativeLook: WKUserScript = {
        let css = """
        /* The page's own header (its name and Subscribe to Updates) and the
           Powered by line: the sheet's title bar is the header. */
        .masthead-container, .masthead, .updates-dropdown-container, .powered-by,
        a[href*="atlassian.com"] { display: none !important; }
        /* Taps and holds as on the app's own screens, not a web page's. */
        html { -webkit-tap-highlight-color: transparent; -webkit-text-size-adjust: 100%; }
        body { -webkit-user-select: none !important; -webkit-touch-callout: none !important; }
        input, textarea { -webkit-user-select: auto !important; }
        /* The system font, as everywhere else in the app (icons keep theirs). */
        body, body *:not(i):not([class*="icon"]) {
            font-family: -apple-system, system-ui, sans-serif !important;
        }
        """
        let source = """
        (function () {
          var style = document.createElement('style');
          style.textContent = `\(css)`;
          // WebKit runs this once the document element is there; wait for
          // it all the same, should it ever not be.
          function addStyle() {
            if (!document.documentElement) return false;
            document.documentElement.appendChild(style);
            return true;
          }
          if (!addStyle()) {
            new MutationObserver(function (records, observer) {
              if (addStyle()) observer.disconnect();
            }).observe(document, { childList: true });
          }
          // The page's width, unzoomable, as a native screen is.
          function fitWidth() {
            var viewport = document.querySelector('meta[name="viewport"]');
            if (!viewport) {
              viewport = document.createElement('meta');
              viewport.name = 'viewport';
              (document.head || document.documentElement).appendChild(viewport);
            }
            viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
          }
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fitWidth);
          } else {
            fitWidth();
          }
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }()
}

// MARK: - WKNavigationDelegate

extension StatusPage: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        // No target frame: a new window, which createWebViewWith decides.
        guard let frame = navigationAction.targetFrame else { return .allow }
        guard frame.isMainFrame else { return Self.allowsSubframe(url) ? .allow : .cancel }
        if url.scheme == "about" { return .allow }
        return allows(url) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loadError = nil
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if host == nil { host = webView.url?.host()?.lowercased() }
        // Shown when it has finished, or after a moment, however far it has
        // got: a slow picture should not keep a spinner over the page.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            await self?.reveal()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadError = nil
        endRefreshing()
        Task { await reveal() }
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

extension StatusPage: WKUIDelegate {
    /// A target="_blank" link: followed here if it is the status page's,
    /// and nowhere otherwise. Never a window of its own.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, host != nil, allows(url) {
            webView.load(URLRequest(url: url, timeoutInterval: Self.timeout))
        }
        return nil
    }
}
