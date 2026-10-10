import Foundation

/// The games, as the site serves them. The only pages that open in the
/// full-screen player.
enum Game: String, CaseIterable, Identifiable {
    case spin
    case flappy
    case tower

    var id: String { rawValue }

    var title: String {
        switch self {
        case .spin: "Spin"
        case .flappy: "Flappy"
        case .tower: "Tower"
        }
    }

    var subtitle: String {
        switch self {
        case .spin: "Spin the empanada"
        case .flappy: "Fly between the pipes"
        case .tower: "Stack it as high as you can"
        }
    }

    var systemImage: String {
        switch self {
        case .spin: "arrow.triangle.2.circlepath"
        case .flappy: "bird.fill"
        case .tower: "square.stack.3d.up.fill"
        }
    }

    var url: URL { SiteURLs.page("/" + rawValue) }

    /// Flappy and Tower draw their own close button in the top bar. The
    /// player hides its native one for them, and their button closes the
    /// player instead of loading the homepage (WebPage's game exit rule).
    /// Spin has none, so it keeps the native one.
    var hasOwnCloseButton: Bool {
        switch self {
        case .spin: false
        case .flappy, .tower: true
        }
    }

    /// Which game a URL is, or nil. /spin, /spin.html and /spin?au=1 are all
    /// Spin.
    static func of(_ url: URL) -> Game? {
        guard SiteURLs.isAppURL(url) else { return nil }
        var path = SiteURLs.normalizedPath(url)
        if path.hasSuffix(".html") { path.removeLast(".html".count) }
        return allCases.first { "/" + $0.rawValue == path }
    }
}

/// Site pages the app shows natively instead of following the link in place.
/// This is what replaces the site's own navigation: a tap on a link to the
/// dashboard or the leaderboard opens that tab, one on the account page opens
/// Settings, one on a game opens the player.
enum NativeRoute: Equatable {
    case home
    case leaderboard
    case settings
    case game(Game)

    static func of(_ url: URL) -> NativeRoute? {
        if let game = Game.of(url) { return .game(game) }
        if SiteURLs.isPath(url, in: SiteURLs.dashboardPaths) { return .home }
        if SiteURLs.isPath(url, in: SiteURLs.leaderboardPaths) { return .leaderboard }
        if SiteURLs.isPath(url, in: SiteURLs.accountPaths) { return .settings }
        return nil
    }

    /// empanadas-io://home, empanadas-io://leaderboard,
    /// empanadas-io://settings and empanadas-io://play/<game>. Anything else
    /// is ignored.
    static func of(deepLink url: URL) -> NativeRoute? {
        guard url.scheme?.lowercased() == AppConfig.urlScheme else { return nil }
        let path = url.path(percentEncoded: false).split(separator: "/").map(String.init)
        switch url.host(percentEncoded: false)?.lowercased() {
        case "home"? where path.isEmpty: return .home
        case "leaderboard"? where path.isEmpty: return .leaderboard
        case "settings"? where path.isEmpty: return .settings
        case "play"? where path.count == 1: return Game(rawValue: path[0]).map { .game($0) }
        default: return nil
        }
    }
}

/// What a response says about the sign-in. Port of signInSignal() in the
/// desktop app's lib/offline.js.
enum SignInSignal: Equatable {
    case signedIn
    case signedOut
    /// Possibly signed out; ask the site before acting on it.
    case unsure

    /// - dashboard.php only answers 200 to a signed-in session.
    /// - Every sign-out goes through /v2/auth/logout.php.
    /// - Landing on the login page usually means the session has ended, but
    ///   WKWebView only shows the final response of a redirect chain, so this
    ///   cannot tell "the dashboard sent me here" from "I opened the login
    ///   page". The caller checks with the site before signing out.
    static func of(responseURL url: URL, statusCode: Int, isMainFrame: Bool) -> SignInSignal? {
        guard SiteURLs.isAppURL(url) else { return nil }
        if SiteURLs.isPath(url, in: SiteURLs.logoutPaths) { return .signedOut }
        guard isMainFrame, statusCode == 200 else { return nil }
        if SiteURLs.isPath(url, in: SiteURLs.dashboardPaths) { return .signedIn }
        if SiteURLs.isPath(url, in: SiteURLs.loginPaths) { return .unsure }
        return nil
    }
}
