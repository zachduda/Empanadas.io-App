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

    static func page(_ path: String) -> URL {
        site.appending(path: path)
    }

    /// A player's profile page, by the id the site gives it.
    static func playerProfile(id: String) -> URL {
        page("/v2/profile/" + id.lowercased())
    }

    /// The profile page with its player search open.
    static let findFriends: URL = {
        var components = URLComponents(url: SiteURLs.profile, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "search", value: "1")]
        return components.url!
    }()

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

    // "Log in with Google/GitHub/Discord" happens in the system browser (an
    // ASWebAuthenticationSession), not in a web view of the app's. The site
    // sends the app to /v2/auth/browser?t=<ticket> when it wants that; the
    // browser signs in and hands the result back with an empanadas-io://auth
    // link, which authRedeemURL turns into the page that finishes the sign-in
    // in the app. The site's half is described above appAuthIssue() in its
    // v2/_lib.php.

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
