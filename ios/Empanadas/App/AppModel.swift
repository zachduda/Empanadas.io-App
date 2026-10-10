import Network
import SwiftUI

enum AppTab: Hashable {
    case home
    case games
    case leaderboard
    case settings
}

enum SessionState: Equatable {
    case signedIn
    case signedOut
}

struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

/// App-wide state: the session, which screen is showing, the native screens'
/// data, and the web pages that outlive a single screen. Everything a WebPage
/// cannot decide by itself comes here.
@MainActor
@Observable
final class AppModel {
    private(set) var session: SessionState
    var selectedTab: AppTab = .home
    var activeGame: Game? {
        didSet {
            if activeGame != oldValue { gameSheet = nil }
            if oldValue != nil && activeGame == nil { gameClosed() }
        }
    }
    var popup: WebPage?
    var shareItem: ShareItem?
    /// A site page opened outside the tabs (see handOff).
    var webSheet: WebLink?
    /// A site page a game linked to, in a sheet over the game player (which
    /// is presented over everything else, so it needs a sheet of its own).
    var gameSheet: WebLink?
    private(set) var isOnline = true

    /// The native Home and Leaderboard tabs' data. Here rather than in the
    /// views, so it outlives a tab switch and goes with the session.
    let dashboard: DashboardModel
    let leaderboard: LeaderboardModel

    /// The account's theme setting: 0 follows the device, 1 light, 2 dark.
    var theme: Int {
        didSet { UserDefaults.standard.set(theme, forKey: Preferences.themeKey) }
    }

    var colorScheme: ColorScheme? {
        switch theme {
        case 1: .light
        case 2: .dark
        default: nil
        }
    }

    /// The login page, shown full screen while signed out.
    private(set) var signInPage: WebPage?

    @ObservationIgnored let account = AccountAPI()
    @ObservationIgnored private let browserSignIn = BrowserSignIn()
    @ObservationIgnored private var backgroundPages: [WebPage] = []
    @ObservationIgnored private var checkingSession = false
    @ObservationIgnored private let pathMonitor = NWPathMonitor()

    init() {
        let defaults = UserDefaults.standard
        session = defaults.bool(forKey: Preferences.signedInKey) ? .signedIn : .signedOut
        theme = defaults.integer(forKey: Preferences.themeKey)
        dashboard = DashboardModel()
        leaderboard = LeaderboardModel()

        if session == .signedOut {
            signInPage = makeSignInPage()
        }
        monitorConnection()
    }

    private func makeSignInPage() -> WebPage {
        WebPage(url: SiteURLs.login, options: .init(interceptsRoutes: false), app: self)
    }

    /// A page for a screen of its own (Settings' web rows, the game player).
    func makePage(_ url: URL, interceptsRoutes: Bool = false, ownRoute: NativeRoute? = nil,
                  pullToRefresh: Bool = true, loadsFromCacheOffline: Bool = false) -> WebPage {
        WebPage(url: url, options: .init(interceptsRoutes: interceptsRoutes, ownRoute: ownRoute,
                                         pullToRefresh: pullToRefresh,
                                         loadsFromCacheOffline: loadsFromCacheOffline), app: self)
    }

    // MARK: - Session

    func observe(_ signal: SignInSignal) {
        switch signal {
        case .signedIn:
            setSession(.signedIn)
        case .signedOut:
            setSession(.signedOut)
        case .unsure:
            // The login page came up while signed in: ask the site rather
            // than throwing the player out on a guess.
            guard session == .signedIn, !checkingSession else { return }
            checkingSession = true
            Task {
                let signedIn = await account.isSignedIn()
                checkingSession = false
                if signedIn == false { setSession(.signedOut) }
            }
        }
    }

    private func setSession(_ new: SessionState) {
        guard new != session else { return }
        session = new
        UserDefaults.standard.set(new == .signedIn, forKey: Preferences.signedInKey)

        switch new {
        case .signedIn:
            selectedTab = .home
            // Not released here: this may be running inside the sign-in
            // page's own delegate callback.
            let finished = signInPage
            Task { @MainActor in
                if self.signInPage === finished { self.signInPage = nil }
            }
        case .signedOut:
            activeGame = nil
            popup = nil
            webSheet = nil
            selectedTab = .home
            // What was saved describes this account; the next one must not
            // open on it.
            dashboard.reset()
            leaderboard.reset()
            OfflineStore.clear()
            signInPage = makeSignInPage()
        }
    }

    /// Signs out the way the site's own button does: by loading
    /// /v2/auth/logout.php, out of sight.
    func signOut() {
        runInBackground(makePage(SiteURLs.logout, pullToRefresh: false))
        setSession(.signedOut)
    }

    /// The site deleted the account: its session is gone with it.
    func accountDeleted() {
        setSession(.signedOut)
    }

    // MARK: - Navigation

    func navigate(to route: NativeRoute) {
        switch route {
        case .home:
            activeGame = nil
            selectedTab = .home
        case .leaderboard:
            activeGame = nil
            selectedTab = .leaderboard
        case .settings:
            activeGame = nil
            selectedTab = .settings
        case .game(let game):
            guard session == .signedIn else { return }
            activeGame = game
        }
    }

    /// Leaves the full-screen game player, back to whichever tab opened it.
    func closeGame() {
        activeGame = nil
    }

    /// A round just ended: its save reaches the site a moment after the
    /// player closes, and the dashboard should show it.
    private func gameClosed() {
        Task {
            try? await Task.sleep(for: .seconds(2))
            guard session == .signedIn, isOnline else { return }
            await dashboard.load(app: self)
        }
    }

    /// Opens a site page a game linked to (Spin's account button, Report a
    /// Problem) over the game, so closing it goes back to the game. Loaded in
    /// the player, it replaced the game, with no way back but closing it.
    func openOverGame(_ url: URL) {
        gameSheet = WebLink(url: url)
    }

    /// Opens a site page over the tabs, in a sheet of its own.
    func openWeb(_ url: URL, title: String? = nil) {
        webSheet = WebLink(url: url, title: title ?? "Empanadas.io")
    }

    /// A popup sign-in reached a page that belongs in the app proper: a
    /// screen the app draws, or else the page itself in a sheet. Signed out,
    /// it is the login page's to finish.
    func handOff(_ url: URL) {
        guard session == .signedIn else {
            signInPage?.load(url)
            return
        }
        if let route = NativeRoute.of(url) {
            navigate(to: route)
        } else {
            openWeb(url)
        }
    }

    func presentPopup(_ page: WebPage) {
        popup = page
    }

    func openPopup(_ url: URL) {
        let page = WebPage(popupWith: WebEnvironment.makeConfiguration(), app: self)
        page.load(url)
        presentPopup(page)
    }

    func dismissPopup(_ page: WebPage) {
        if popup === page { popup = nil }
        backgroundPages.removeAll { $0 === page }
    }

    /// Keeps a page alive without showing it, long enough for it to finish.
    func runInBackground(_ page: WebPage) {
        backgroundPages.append(page)
        Task {
            try? await Task.sleep(for: .seconds(20))
            backgroundPages.removeAll { $0 === page }
        }
    }

    func openExternally(_ url: URL) {
        guard ["https", "mailto", "tel", "sms"].contains(url.scheme?.lowercased() ?? "") else { return }
        UIApplication.shared.open(url)
    }

    func share(_ url: URL) {
        shareItem = ShareItem(url: url)
    }

    // MARK: - Browser sign-in

    func startBrowserSignIn(_ url: URL, from page: WebPage) {
        browserSignIn.origin = page.isPopup ? page.opener : page
        browserSignIn.start(url) { [weak self] link in
            self?.finishBrowserSignIn(link)
        }
    }

    private func finishBrowserSignIn(_ link: URL) {
        guard browserSignIn.isExpecting, let url = SiteURLs.authRedeemURL(link) else { return }
        let origin = browserSignIn.origin
        browserSignIn.finish()
        popup = nil

        // Back to the page that started it (Settings' account page when
        // linking a provider), or a sheet of its own if that is gone.
        if let origin, origin === signInPage || origin.webView.window != nil {
            origin.load(url)
        } else if session == .signedIn {
            openWeb(url, title: "Sign In")
        } else {
            signInPage?.load(url)
        }
    }

    // MARK: - Deep links and quick actions

    func open(_ url: URL) {
        guard url.scheme?.lowercased() == AppConfig.urlScheme, url.absoluteString.count <= 2048 else { return }

        if SiteURLs.isAuthDeepLink(url) {
            finishBrowserSignIn(url)
        } else if let route = NativeRoute.of(deepLink: url) {
            navigate(to: route)
        }
    }

    func performQuickAction(_ type: String) {
        let prefix = "io.empanadas.app.play."
        guard type.hasPrefix(prefix), let game = Game(rawValue: String(type.dropFirst(prefix.count))) else { return }
        navigate(to: .game(game))
    }

    // MARK: - Connection

    private func monitorConnection() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                guard let self, self.isOnline != online else { return }
                self.isOnline = online
                // Back online: retry whatever failed while it was not. The
                // native screens refresh themselves when they are showing.
                if online, let page = self.signInPage, page.loadError != nil {
                    page.reload()
                }
            }
        }
        pathMonitor.start(queue: .main)
    }
}
