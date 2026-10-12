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

/// Where the welcome screen is with a sign-in.
enum SignInProgress: Equatable {
    case idle
    /// Open in the system browser.
    case inBrowser
    /// Back from the browser: the app's own session is being signed in.
    case finishing
}

/// App-wide state: the session, which screen is showing, the native screens'
/// data, and the web pages that outlive a single screen. Everything a WebPage
/// cannot decide by itself comes here.
@MainActor
@Observable
final class AppModel {
    private(set) var session: SessionState
    var selectedTab: AppTab = .home
    /// What is pushed on the Home tab: a profile, Find Friends, a site page.
    /// Here so a profile link from anywhere (a site page, a deep link) can
    /// open on it.
    var homePath = NavigationPath()
    var activeGame: Game? {
        didSet {
            if activeGame != oldValue { gameSheet = nil }
            if oldValue != nil && activeGame == nil { gameClosed() }
        }
    }
    var popup: WebPage?
    /// A site page opened outside the tabs (see handOff).
    var webSheet: WebLink?
    /// A site page a game linked to, in a sheet over the game player (which
    /// is presented over everything else, so it needs a sheet of its own).
    var gameSheet: WebLink?
    private(set) var isOnline = true

    /// The native Home, Leaderboard and Settings tabs' data. Here rather than
    /// in the views, so it outlives a tab switch and goes with the session,
    /// and is made once: a model made as a view's @State is made again (and
    /// reads its saved copy again) every time the view is rebuilt.
    let dashboard: DashboardModel
    let leaderboard: LeaderboardModel
    let settings: SettingsModel
    /// Game Center's leaderboards, fed by the dashboard.
    let gameCenter: GameCenter

    /// The account's theme setting: 0 follows the device, 1 light, 2 dark.
    var theme: Int {
        didSet { UserDefaults.standard.set(theme, forKey: Preferences.themeKey) }
    }

    /// What the window is drawn in: the theme, except on the welcome screen,
    /// which is the whole screen and navy, like the site's sign-in pages and
    /// the launch screen. The status bar over it is white whatever the theme.
    var interfaceStyle: UIUserInterfaceStyle {
        if session == .signedOut { return .dark }
        switch theme {
        case 1: return .light
        case 2: return .dark
        default: return .unspecified
        }
    }

    /// The welcome screen's sign-in, and why the last one did not finish.
    private(set) var signInProgress: SignInProgress = .idle
    var signInError: String?

    @ObservationIgnored let account: AccountAPI
    /// Signing in to the app: the whole of it, in the system browser.
    @ObservationIgnored private let signInBrowser = BrowserSession()
    @ObservationIgnored private var pendingSignIn: SignInRequest?
    /// Connecting a provider from the account page.
    @ObservationIgnored private let browserSignIn = BrowserSignIn()
    /// /v2/auth/logout.php, out of sight, until it has signed the site out.
    @ObservationIgnored private var signOutPage: WebPage?
    @ObservationIgnored private var backgroundPages: [WebPage] = []
    @ObservationIgnored private var checkingSession = false
    @ObservationIgnored private let pathMonitor = NWPathMonitor()

    /// `account`: the screenshot tests give it one that answers for the site.
    init(account: AccountAPI = AccountAPI()) {
        self.account = account
        let defaults = UserDefaults.standard
        session = defaults.bool(forKey: Preferences.signedInKey) ? .signedIn : .signedOut
        theme = defaults.integer(forKey: Preferences.themeKey)
        dashboard = DashboardModel()
        leaderboard = LeaderboardModel()
        settings = SettingsModel()
        gameCenter = GameCenter()

        // A sign-out the site never heard about (no connection, and the app
        // was closed before there was one).
        if session == .signedOut && defaults.bool(forKey: Preferences.signOutPendingKey) {
            signOutOnSite()
        }
        monitorConnection()
        // Before the first request needs it, and outside any Swift task.
        WebEnvironment.readUserAgent()
        if session == .signedIn { gameCenter.start() }
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
            // A page is on its way to /v2/auth/logout.php. It may be torn
            // down with the tabs before it gets there, so the app signs the
            // site out itself too (twice is harmless).
            setSession(.signedOut, signingOut: true)
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

    /// `signingOut`: the session may still be live on the site, so the site
    /// is signed out too (signOutOnSite).
    private func setSession(_ new: SessionState, signingOut: Bool = false) {
        guard new != session else { return }
        session = new
        UserDefaults.standard.set(new == .signedIn, forKey: Preferences.signedInKey)

        switch new {
        case .signedIn:
            selectedTab = .home
            signInProgress = .idle
            signInError = nil
            pendingSignIn = nil
            gameCenter.start()
            Task { await self.refreshTheme() }
        case .signedOut:
            activeGame = nil
            popup = nil
            webSheet = nil
            selectedTab = .home
            homePath = NavigationPath()
            account.forgetToken()
            // What was saved describes this account; the next one must not
            // open on it.
            dashboard.reset()
            leaderboard.reset()
            settings.reset()
            gameCenter.reset()
            OfflineStore.clear()
            ImageStore.shared.clear()
            if signingOut { signOutOnSite() }
        }
    }

    /// Signs out the way the site's own button does: by loading
    /// /v2/auth/logout.php (see signOutOnSite).
    func signOut() {
        setSession(.signedOut, signingOut: true)
    }

    /// Signs the site out as well: /v2/auth/logout.php, in a page nobody sees.
    /// That ends the session and clears what the site's scripts keep about
    /// the account in the web views' storage. Kept until the page has gone
    /// on to the login page (loginPageReached), and tried again when the
    /// connection comes back, or at the next launch: a sign-out made offline
    /// happens later rather than not at all.
    private func signOutOnSite() {
        UserDefaults.standard.set(true, forKey: Preferences.signOutPendingKey)
        signOutPage = makePage(SiteURLs.logout, pullToRefresh: false)
    }

    private func signedOutOnSite() {
        UserDefaults.standard.set(false, forKey: Preferences.signOutPendingKey)
        // Not released here: this runs inside the page's own delegate
        // callback.
        let finished = signOutPage
        Task { @MainActor in
            if self.signOutPage === finished { self.signOutPage = nil }
        }
    }

    /// The site deleted the account: its session is gone with it.
    func accountDeleted() {
        setSession(.signedOut)
    }

    /// The account's theme, from the site. Settings brings it in whenever it
    /// loads, but that may be days away, and the theme can be changed on the
    /// website too: until then the app was light while every site page in
    /// it was dark, or the other way round.
    func refreshTheme() async {
        guard session == .signedIn, isOnline else { return }
        guard let snapshot = try? await account.snapshot(), session == .signedIn else { return }
        if theme != snapshot.settings.theme { theme = snapshot.settings.theme }
    }

    // MARK: - Navigation

    func navigate(to route: NativeRoute) {
        // A link followed in the web sheet (WebSheetView intercepts routes)
        // goes to a screen under the sheet, or a game player that cannot be
        // presented while the sheet is: the sheet goes, so the screen shows.
        webSheet = nil
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
        case .profile(let id):
            show(.player(id: id, name: nil))
        case .findFriends:
            show(.findFriends)
        case .feedback(let reason):
            guard session == .signedIn else { return }
            // In a sheet, which WebSheetView draws natively: over the game
            // when one is up (Spin's Report a Problem), so closing it goes
            // back to the game, and over the tabs otherwise.
            let link = WebLink(url: SiteURLs.feedback(reason: reason), title: "Send Feedback")
            if activeGame != nil {
                gameSheet = link
            } else {
                webSheet = link
            }
        }
    }

    /// A profile or Find Friends, on the Home tab, over whatever it was
    /// showing.
    private func show(_ route: ProfileRoute) {
        guard session == .signedIn else { return }
        activeGame = nil
        selectedTab = .home
        homePath.append(route)
    }

    /// A friend was added, accepted or let go: the dashboard's friends card
    /// and counts should say so.
    func friendsChanged() {
        Task {
            guard session == .signedIn, isOnline else { return }
            await dashboard.reload(app: self)
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
            await dashboard.reload(app: self)
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

    /// A popup reached a page that belongs in the app proper: a screen the
    /// app draws, or else the page itself in a sheet. The login page is
    /// neither (loginPageReached).
    func handOff(_ url: URL) {
        guard session == .signedIn else { return }
        if SiteURLs.isPath(url, in: SiteURLs.loginPaths) {
            observe(.unsure)
        } else if let route = NativeRoute.of(url) {
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
        ShareSheet.present([url])
    }

    // MARK: - Signing in

    /// "Yup!" or "Nope." on the welcome screen. The whole sign-in happens in
    /// the system browser, on the site's own pages (the username step or Pick
    /// a Username, passkeys, Google/GitHub/Discord, 2FA), where Safari's
    /// AutoFill and the player's saved passkeys work. None of that reaches a
    /// web view of the app's. See SignInRequest.
    func signIn(_ mode: SignInMode) {
        guard session == .signedOut, signInProgress == .idle else { return }
        guard isOnline else {
            signInError = "You're offline. Signing in needs a connection."
            return
        }
        let request = SignInRequest(mode: mode)
        pendingSignIn = request
        signInError = nil
        signInProgress = .inBrowser
        let opened = signInBrowser.open(request.url) { [weak self] link in
            self?.browserClosed(on: link)
        }
        if !opened {
            signInProgress = .idle
            signInError = "The sign-in window couldn't open. Try again."
        }
    }

    private func browserClosed(on link: URL?) {
        if let link {
            finishSignIn(link)
        } else if signInProgress == .inBrowser {
            // Closed. The request is kept: a sign-in can still finish in
            // Safari (a provider's own app handing back to it), which opens
            // the app with the link.
            signInProgress = .idle
        }
    }

    /// Back from the browser with empanadas-io://signin?code=. The code and
    /// the request's verifier sign the app's own session in.
    private func finishSignIn(_ link: URL) {
        guard session == .signedOut, signInProgress != .finishing else { return }
        guard let request = pendingSignIn, request.isFresh(), let code = SiteURLs.signInCode(link) else {
            // Not a sign-in this app started, or one it gave up on.
            if signInProgress == .inBrowser { signInProgress = .idle }
            return
        }
        pendingSignIn = nil
        signInProgress = .finishing
        signInError = nil
        // Still up when the link came the long way round, through Safari.
        signInBrowser.cancel()
        Task {
            await waitForSignOutOnSite()
            do {
                try await account.redeemSignIn(code: code, verifier: request.verifier)
            } catch {
                signInProgress = .idle
                signInError = (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again!"
                return
            }
            setSession(.signedIn)
            // What the site's scripts keep about the account in the web
            // views' storage (SiteURLs.signedInHandoff). It goes on to the
            // dashboard, which confirms the session (SignInSignal).
            runInBackground(makePage(SiteURLs.signedInHandoff, pullToRefresh: false))
        }
    }

    /// A sign-out still on its way to the site would end the session this
    /// sign-in is about to start. It gets a moment to land; one that cannot
    /// (no connection) is dropped, since signing in replaces the session
    /// anyway.
    private func waitForSignOutOnSite() async {
        for _ in 0..<50 {
            guard let page = signOutPage, page.loadError == nil else { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let page = signOutPage {
            page.webView.stopLoading()
            signedOutOnSite()
        }
    }

    /// A page of the app's went for the login page, which never shows in the
    /// app: signing in happens in the system browser (signIn).
    func loginPageReached(from page: WebPage) {
        if page === signOutPage {
            // logout.php has signed the site out and is moving on.
            signedOutOnSite()
            return
        }
        switch session {
        case .signedIn:
            // The site sent a page there: the session may have ended. Ask,
            // rather than throw the player out on a guess.
            observe(.unsure)
        case .signedOut:
            // A link on a page opened from the welcome screen (the privacy
            // policy, the terms): the welcome screen is the way in.
            webSheet = nil
        }
    }

    // MARK: - Connecting a provider

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

        // Back to the page that started it (the account page), or a sheet
        // of its own if that is gone.
        if let origin, origin.webView.window != nil {
            origin.load(url)
        } else if session == .signedIn {
            openWeb(url)
        }
    }

    // MARK: - Deep links and quick actions

    func open(_ url: URL) {
        guard url.scheme?.lowercased() == AppConfig.urlScheme, url.absoluteString.count <= 2048 else { return }

        if SiteURLs.isAuthDeepLink(url) {
            finishBrowserSignIn(url)
        } else if SiteURLs.isSignInDeepLink(url) {
            finishSignIn(url)
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
                if online, let page = self.signOutPage, page.loadError != nil {
                    page.reload()
                }
            }
        }
        pathMonitor.start(queue: .main)
    }
}
