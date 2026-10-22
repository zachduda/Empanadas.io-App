import Foundation

// Which URLs the app will load, and where. A port of lib/urls.js and the URL
// half of lib/offline.js from the desktop app, kept free of WebKit so the
// tests can check it directly - a mistake in here is either a hole in the
// navigation filter or a sign-in flow that silently stops working.
enum SiteURLs {
    // The one place that decides what counts as "our site". Hosts are parsed
    // and compared, never prefix-matched: 'https://empanadas.io.example.com'
    // and 'https://empanadas.io@example.com' both pass a prefix test.
    static let appHost = "empanadas.io"
    static let site = URL(string: "https://empanadas.io")!

    // Hosts that sign a user in. Exact hosts, no suffix matching. Only the
    // sign-in popup may load them, never a main page (where the bridge lives).
    static let authHosts: Set<String> = [
        "accounts.google.com",
        "github.com",
        "www.github.com",
        "discord.com",
        "canary.discord.com",
        "ptb.discord.com",
        "discordapp.com",
        "appleid.apple.com",
        "accounts.youtube.com",
    ]

    // Sites that share an account with empanadas.io (the post-sign-in
    // "roundabout"). Only the popup may visit them.
    static let ssoHosts: Set<String> = [
        "zachduda.com",
        "www.zachduda.com",
        "he1ium.com",
        "www.he1ium.com",
        "mountaineermetrics.com",
        "www.mountaineermetrics.com",
    ]

    // Pages a popup sign-in finishes on. When the popup reaches one, the page
    // belongs in the app proper rather than in the popup.
    private static let handoffPaths: Set<String> = [
        "/v2/dashboard", "/v2/dashboard.php",
        "/v2/account", "/v2/account/index.php",
        "/v2/login", "/v2/login.php",
        "/v2/profile", "/v2/profile.php",
    ]

    private static let browserSignInPaths: Set<String> = ["/v2/auth/browser", "/v2/auth/browser.php"]

    static let dashboardPaths: Set<String> = ["/v2/dashboard", "/v2/dashboard.php"]
    static let leaderboardPaths: Set<String> = ["/leaderboard", "/leaderboard.html"]
    /// The homepage, which the games' own close buttons go back to.
    static let homePaths: Set<String> = ["/", "/index", "/index.html", "/index.php"]
    static let accountPaths: Set<String> = ["/v2/account", "/v2/account/index.php"]
    /// The profile page without an id in its path: the player's own, or the
    /// one named by ?id=.
    static let profilePaths: Set<String> = ["/v2/profile", "/v2/profile.php"]
    static let loginPaths: Set<String> = ["/v2/login", "/v2/login.php"]
    static let logoutPaths: Set<String> = ["/v2/auth/logout", "/v2/auth/logout.php"]

    static let login = page("/v2/login")
    static let logout = page("/v2/auth/logout.php")
    static let account = page("/v2/account")
    static let profile = page("/v2/profile")
    static let twoFactor = page("/v2/account_2fa")
    static let profilePicture = page("/v2/update_pfp")
    static let verifyEmail = page("/v2/verify_email")
    static let feedback = page("/v2/feedback")
    static let privacy = page("/privacy.html")
    static let terms = page("/terms.html")
    /// The app's own API on the site: JSON in, JSON out (html/v2/ios/ there).
    /// It has to be under /v2/: the session cookie is scoped to /v2, so
    /// AccountAPI sends it nowhere else, and Cloudflare caches the rest.
    static let iosAccount = page("/v2/ios/account.php")
    static let iosDashboard = page("/v2/ios/dashboard.php")
    static let iosLeaderboard = page("/v2/ios/leaderboard.php")
    static let iosSearch = page("/v2/ios/search.php")
    static let iosFeedback = page("/v2/ios/feedback.php")
    /// Where a sign-in run in the browser is redeemed (SignInRequest).
    static let iosSignIn = page("/v2/ios/signin.php")
    /// The save points behind the dashboard's Spin Progress chart, and
    /// restoring one: the site's own endpoint for its "Manage game data"
    /// dialog, which the app's Manage Game Data screen uses too.
    static let gameHistory = page("/v2/gamehistory")
    /// The feedback page in every shape the site links it (v2/dashboard.php's
    /// footer links a bare "feedback"). The app's Send Feedback screen
    /// stands in for it.
    static let feedbackPaths: Set<String> = ["/v2/feedback", "/v2/feedback.php"]
    /// The site's announcements page. The app's Updates screen stands in for
    /// it.
    static let updatesPaths: Set<String> = ["/updates", "/updates.html"]

    /// The site's public API, on a host of its own.
    static let api = URL(string: "https://api.empanadas.io")!

    /// One announcement, as the site's Updates page asks for it (updates.js):
    /// by `page`, 0 the newest, or the one with the id `post`. `fresh` asks
    /// past the ten minutes the answer is cached for, as the page's own
    /// reload does.
    static func updatesAPI(page number: Int = 0, post: String? = nil, fresh: Bool = false) -> URL {
        var components = URLComponents(url: api.appending(path: "/v1/updates.php"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "v", value: "1"), URLQueryItem(name: "page", value: String(max(0, number)))]
        if let post { items.append(URLQueryItem(name: "post", value: post)) }
        if fresh { items.append(URLQueryItem(name: "sc", value: String(Int(Date().timeIntervalSince1970 * 1000)))) }
        components.queryItems = items
        return components.url!
    }

    /// The feedback page asking for one subject, as Spin's Report a Problem
    /// links it (?reason=3). What NativeRoute reads back.
    static func feedback(reason: Int?) -> URL {
        guard let reason else { return feedback }
        var components = URLComponents(url: feedback, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "reason", value: String(reason))]
        return components.url!
    }

    /// The signed-in player's own profile, or another player's.
    static func iosProfile(id: String? = nil) -> URL {
        guard let id, !id.isEmpty else { return page("/v2/ios/profile.php") }
        var components = URLComponents(url: page("/v2/ios/profile.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "id", value: id.lowercased())]
        return components.url!
    }

    /// The newest save points, or with `before` the page older than that one.
    static func gameHistory(before id: Int?) -> URL {
        guard let id, id > 0 else { return gameHistory }
        var components = URLComponents(url: gameHistory, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "before", value: String(id))]
        return components.url!
    }

    /// One page of a player search.
    static func iosSearch(_ query: String, page number: Int = 0) -> URL {
        var components = URLComponents(url: iosSearch, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        if number > 0 { components.queryItems?.append(URLQueryItem(name: "p", value: String(number))) }
        return components.url!
    }

    static func page(_ path: String) -> URL {
        site.appending(path: path)
    }

    /// A player's profile page, by the id the site gives it.
    static func playerProfile(id: String) -> URL {
        page("/v2/profile/" + id.lowercased())
    }

    /// The profile page with its player search open. Straight to the
    /// player's own profile when their id is known: the site's /v2/profile
    /// redirect to it dropped ?search=1, so Find Friends opened a plain
    /// profile, the same as My Profile.
    static func findFriends(id: String? = nil) -> URL {
        let base = id.flatMap { $0.isEmpty ? nil : playerProfile(id: $0) } ?? profile
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "search", value: "1")]
        return components.url!
    }

    /// A picture path as the site gives it ("/Content/Images/..."), made
    /// absolute. Only https: never a plain-http or file URL.
    static func resolve(_ path: String?) -> URL? {
        guard let path, !path.isEmpty, let url = URL(string: path, relativeTo: site)?.absoluteURL,
              url.scheme?.lowercased() == "https" else { return nil }
        return url
    }

    // MARK: - Classifying URLs

    /// The host of an https URL, lowercased, or nil for anything else. An http
    /// hop is a downgrade, and for an auth flow it is a downgrade carrying a
    /// token.
    static func host(of url: URL) -> String? {
        guard url.scheme?.lowercased() == "https", let host = url.host(percentEncoded: false) else {
            return nil
        }
        return host.lowercased()
    }

    static func isAppHost(_ host: String) -> Bool {
        let host = host.lowercased()
        return host == appHost || host.hasSuffix("." + appHost)
    }

    static func isAppURL(_ url: URL) -> Bool {
        guard let host = host(of: url) else { return false }
        return isAppHost(host)
    }

    static func isAuthURL(_ url: URL) -> Bool {
        guard let host = host(of: url) else { return false }
        return authHosts.contains(host)
    }

    static func isSSOURL(_ url: URL) -> Bool {
        guard let host = host(of: url) else { return false }
        return ssoHosts.contains(host)
    }

    /// Where a sign-in popup may go: the site, the providers, and the sibling
    /// sites the roundabout passes through.
    static func isPopupURL(_ url: URL) -> Bool {
        isAppURL(url) || isAuthURL(url) || isSSOURL(url)
    }

    static func isHandoffURL(_ url: URL) -> Bool {
        isAppURL(url) && handoffPaths.contains(normalizedPath(url))
    }

    /// The path with trailing slashes removed, "/" for an empty one.
    static func normalizedPath(_ url: URL) -> String {
        var path = url.path(percentEncoded: false)
        while path.hasSuffix("/") { path.removeLast() }
        return path.isEmpty ? "/" : path
    }

    static func isPath(_ url: URL, in paths: Set<String>) -> Bool {
        isAppURL(url) && paths.contains(normalizedPath(url))
    }

    /// Where a game sends the player when they leave it: its own close button
    /// (backToGames() in the site's _flappy.js and _tower.js) replaces the
    /// page with the homepage, or the dashboard. In the full-screen player
    /// that means "close the player", whatever started the navigation.
    static func isGameExitURL(_ url: URL) -> Bool {
        isPath(url, in: homePaths) || isPath(url, in: dashboardPaths)
    }

    // MARK: - Browser sign-in

    // A Google/GitHub/Discord round trip a page of the app's starts (the
    // account page's Connect) happens in the system browser (an
    // ASWebAuthenticationSession), not in a web view of the app's. The site
    // sends the app to /v2/auth/browser?t=<ticket> when it wants that; the
    // browser signs in and hands the result back with an empanadas-io://auth
    // link, which authRedeemURL turns into the page that finishes it in the
    // app. The site's half is described above appAuthIssue() in its
    // v2/_lib.php. Signing in to the app is the section below.

    static func isBrowserSignInURL(_ url: URL) -> Bool {
        guard isAppURL(url), browserSignInPaths.contains(url.path(percentEncoded: false)) else {
            return false
        }
        return isAuthToken(queryValue("t", in: url))
    }

    /// Is this one of the empanadas-io://auth links a browser sign-in comes
    /// back with? Those are the app's to handle, never passed on to the page.
    static func isAuthDeepLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == AppConfig.urlScheme && url.host(percentEncoded: false)?.lowercased() == "auth"
    }

    /// The page that finishes a browser sign-in, or nil if the link is not
    /// one. Anything on the device can open an empanadas-io:// link, so every
    /// part is checked against the shape the site produces.
    static func authRedeemURL(_ link: URL) -> URL? {
        guard isAuthDeepLink(link) else { return nil }
        let path = link.path(percentEncoded: false)
        guard path.isEmpty || path == "/" else { return nil }

        let service = queryValue("service", in: link) ?? ""
        let ticket = queryValue("t", in: link)
        let code = queryValue("c", in: link)
        guard isAuthService(service), isAuthToken(ticket), isAuthToken(code) else { return nil }

        var components = URLComponents(url: page("/v2/auth/flow.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "service", value: service),
            URLQueryItem(name: "app_ticket", value: ticket),
            URLQueryItem(name: "app_code", value: code),
        ]
        return components.url
    }

    // MARK: - Signing in to the app

    // The whole sign-in runs in the system browser (SignInRequest): the
    // browser starts at /v2/auth/app.php with the request's PKCE challenge,
    // and the site hands it back with empanadas-io://signin?code=<code>, which
    // the app redeems at /v2/ios/signin.php. The site's half is described
    // above APP_SIGNIN_TTL in its v2/_lib.php.

    /// Where the browser starts: the site's username step, or Pick a Username.
    static func appSignIn(challenge: String, mode: SignInMode) -> URL {
        var components = URLComponents(url: page("/v2/auth/app.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "challenge", value: challenge),
            URLQueryItem(name: "mode", value: mode.rawValue),
        ]
        return components.url!
    }

    /// Is this one of the empanadas-io://signin links a sign-in comes back
    /// with? Those are the app's to handle, never passed on to a page.
    static func isSignInDeepLink(_ url: URL) -> Bool {
        url.scheme?.lowercased() == AppConfig.urlScheme && url.host(percentEncoded: false)?.lowercased() == "signin"
    }

    /// The code a sign-in link carries, or nil if the link is not one.
    /// Anything on the device can open an empanadas-io:// link, so it is
    /// checked against the shape the site produces (appSigninDeepLink()).
    static func signInCode(_ link: URL) -> String? {
        guard isSignInDeepLink(link) else { return nil }
        let path = link.path(percentEncoded: false)
        guard path.isEmpty || path == "/" else { return nil }
        let code = queryValue("code", in: link)
        return isAuthToken(code) ? code : nil
    }

    /// Loaded in a web view once the app is signed in: /v2/auth/js.php,
    /// which every sign-in on the site passes through, fills in what the
    /// site's scripts keep in the web views' storage about the account (the
    /// cache core.js reads before it asks the site anything). A sign-in made
    /// in the browser left that in Safari's storage, not the app's.
    static let signedInHandoff: URL = {
        var components = URLComponents(url: page("/v2/auth/js.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "r", value: "/v2/dashboard")]
        return components.url!
    }()

    // Tickets and codes are random letters and digits; see appAuthToken() in
    // the site's v2/_lib.php.
    static func isAuthToken(_ value: String?) -> Bool {
        guard let value, (32...128).contains(value.count) else { return false }
        return value.unicodeScalars.allSatisfy { isASCIIAlphanumeric($0) }
    }

    private static func isAuthService(_ value: String) -> Bool {
        (2...16).contains(value.count) && value.unicodeScalars.allSatisfy { ("a"..."z").contains($0) }
    }

    private static func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    /// The first value of a query parameter, like URLSearchParams.get().
    static func queryValue(_ name: String, in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == name })?
            .value
    }
}
