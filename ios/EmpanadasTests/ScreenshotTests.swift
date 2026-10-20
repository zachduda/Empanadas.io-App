import SwiftUI
import XCTest
@testable import Empanadas

/// Draws the native screens, with a made-up account, at the sizes the app
/// runs at: on an iPhone its own screen; on an iPad its screen both ways
/// round, half of it in Split View, and a wide Mac window (the app runs on a
/// Mac as an iPad app, in a window that can be as wide as the display).
/// Nothing is compared: the pictures are for looking at, and the iOS workflow
/// uploads them as the run's "screenshots" artifact.
///
/// Only runs when SCREENSHOTS_DIR names a folder to write them to (from
/// xcodebuild, TEST_RUNNER_SCREENSHOTS_DIR=...). It signs the simulator's copy
/// of the app in as the made-up account and leaves it signed out, so it is
/// skipped in a plain ⌘U.
@MainActor
final class ScreenshotTests: XCTestCase {
    private struct Size {
        let name: String
        let size: CGSize
        let horizontal: UIUserInterfaceSizeClass
    }

    private struct Screen {
        let name: String
        var signedIn = true
        var tab: AppTab = .home
        /// Pushed on the Home tab: a ProfileRoute or an UpdatesRoute.
        var route: (any Hashable)?
    }

    private static let screens = [
        Screen(name: "home"),
        Screen(name: "games", tab: .games),
        Screen(name: "leaderboard", tab: .leaderboard),
        Screen(name: "settings", tab: .settings),
        Screen(name: "profile", route: ProfileRoute.player(id: nil, name: nil)),
        Screen(name: "updates", route: UpdatesRoute.all),
        Screen(name: "welcome", signedIn: false),
    ]

    private var directory: URL!
    private var wasSignedIn = false
    private var lastSeenUpdate: String?
    private var playHistory: [Game: Date] = [:]

    override func setUp() async throws {
        guard let path = ProcessInfo.processInfo.environment["SCREENSHOTS_DIR"], !path.isEmpty else {
            throw XCTSkip("Set SCREENSHOTS_DIR (TEST_RUNNER_SCREENSHOTS_DIR for xcodebuild) to draw the screenshots.")
        }
        directory = URL(filePath: path, directoryHint: .isDirectory)
        wasSignedIn = UserDefaults.standard.bool(forKey: Preferences.signedInKey)
        lastSeenUpdate = UserDefaults.standard.string(forKey: Preferences.updatesSeenKey)
        playHistory = PlayHistory.load()
    }

    override func tearDown() async throws {
        guard directory != nil else { return }
        OfflineStore.clear()
        OfflineGamesRecord.forget()
        UserDefaults.standard.set(wasSignedIn, forKey: Preferences.signedInKey)
        UserDefaults.standard.set(lastSeenUpdate, forKey: Preferences.updatesSeenKey)
        PlayHistory.save(playHistory)
    }

    func testDrawsTheScreensAtEachSize() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let bounds = scene.screen.bounds.size
        let portrait = CGSize(width: min(bounds.width, bounds.height), height: max(bounds.width, bounds.height))
        let landscape = CGSize(width: portrait.height, height: portrait.width)

        let device: String
        let sizes: [Size]
        if UIDevice.current.userInterfaceIdiom == .pad {
            device = "ipad"
            sizes = [
                Size(name: "portrait", size: portrait, horizontal: .regular),
                Size(name: "landscape", size: landscape, horizontal: .regular),
                // Split View, half each: compact, as on a phone.
                Size(name: "split-view", size: CGSize(width: ((landscape.width - 10) / 2).rounded(), height: landscape.height),
                     horizontal: .compact),
                Size(name: "mac-window", size: CGSize(width: 1600, height: 1000), horizontal: .regular),
            ]
        } else {
            device = "iphone"
            sizes = [Size(name: "portrait", size: portrait, horizontal: .compact)]
        }

        let folder = directory.appending(path: device, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        for size in sizes {
            for screen in Self.screens {
                let image = try await draw(screen, size: size, in: scene)
                let name = "\(screen.name)-\(size.name)"
                try XCTUnwrap(image.pngData()).write(to: folder.appending(path: name + ".png"))
                let attachment = XCTAttachment(image: image)
                attachment.name = "\(device)-\(name)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }

    /// One screen, in a window of its own of the given size, once it has
    /// settled.
    private func draw(_ screen: Screen, size: Size, in scene: UIWindowScene) async throws -> UIImage {
        Fixtures.seed()
        UserDefaults.standard.set(screen.signedIn, forKey: Preferences.signedInKey)
        let model = AppModel(account: AccountAPI(protocolClasses: [FakeSite.self]))
        model.selectedTab = screen.tab
        if let route = screen.route { model.homePath.append(route) }

        let root: AnyView = screen.signedIn
            ? AnyView(MainTabView().environment(model))
            : AnyView(WelcomeView().environment(model))
        let host = UIHostingController(rootView: root)
        host.traitOverrides.horizontalSizeClass = size.horizontal
        host.traitOverrides.verticalSizeClass = .regular
        host.overrideUserInterfaceStyle = screen.signedIn ? .light : .dark

        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size.size)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        // The answers from FakeSite, the pictures, the charts' animation.
        try await Task.sleep(for: .seconds(2))
        window.layoutIfNeeded()

        let screenBounds = scene.screen.bounds
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        return renderer.image { context in
            // As on screen, materials and all, where the window fits on the
            // simulator's screen. Wider than that (landscape on a portrait
            // simulator, the Mac window), drawHierarchy leaves out what is
            // off screen, so the layers are drawn instead: right for layout,
            // though blurs come out flat.
            if screenBounds.contains(window.frame) {
                _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            } else {
                window.layer.render(in: context.cgContext)
            }
        }
    }
}

// MARK: - The made-up account

/// Answers the app's own endpoints with the fixtures, in place of the site.
private final class FakeSite: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let body = Fixtures.answer(for: url)
        let response = HTTPURLResponse(url: url, statusCode: body == nil ? 404 : 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body ?? Data(#"{"ok":false,"api":1,"reason":"not_found"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// What the site's /v2/ios/ endpoints would say about a player a few weeks
/// in: friends, a request waiting, scores in all three games, pumpkin season.
/// And the site's announcements, two of them posted since the player last
/// looked.
private enum Fixtures {
    static let picture = "/Content/Images/defaultpfp.png"

    /// The saved copies the screens open with, as after a good answer.
    static func seed() {
        OfflineStore.clear()
        OfflineStore.save(json(dashboard), as: .dashboard)
        OfflineStore.save(json(leaderboard), as: .leaderboard)
        OfflineStore.save(json(account), as: .settings)
        OfflineStore.save(json(profile), as: .profile)
        // Saved for offline already: a model signed in would otherwise fetch
        // every game from the live site while the screens are drawn.
        OfflineGamesRecord.saved()
        // Seen up to the third: the bell has a dot, and the two above it are
        // New.
        UserDefaults.standard.set(posts[2]["id"] as? String, forKey: Preferences.updatesSeenKey)
        // Flappy a couple of hours ago (Jump Back In), Spin yesterday, and
        // Tower only ever on the website: the Games tab's three cases.
        let now = Date()
        PlayHistory.save([.flappy: now.addingTimeInterval(-2 * 3600), .spin: now.addingTimeInterval(-26 * 3600)])
    }

    static func answer(for url: URL) -> Data? {
        switch url.path() {
        case "/v2/ios/dashboard.php": json(dashboard)
        case "/v2/ios/leaderboard.php": json(leaderboard)
        case "/v2/ios/account.php": json(account)
        case "/v2/ios/profile.php": json(profile)
        case "/v1/updates.php": updates(url)
        default: nil
        }
    }

    /// The announcements, newest first, as the admin panel would have saved
    /// them.
    static let posts: [[String: Any]] = [
        post("k3n9q2", "Spin Got a Makeover", "2 hours ago", """
            <p>The <b>Spin</b> game has a fresh look, and it&#39;s <i>faster</i> on every device.</p>
            <ul><li>New upgrades in the shop</li><li>Smoother animations</li><li>Haptics on iPhone</li></ul>
            <p>Give it a <a href="/spin">spin</a> and tell us what you think!</p>
            """),
        post("f7h2m1", "Tower Leaderboards Are Live", "3 days ago", """
            <h3>Stack your way to the top</h3>
            Your tallest tower now counts on the leaderboard. See <a href="/leaderboard">where you rank</a>.
            """),
        post("a1b2c3", "Welcome to the App! &#x1F389;", "2 weeks ago", """
            <p>Empanadas.io is on iPhone and iPad now.</p>
            <blockquote>Play offline, and your saves sync when you&#39;re back.</blockquote>
            """, edited: "1 week ago"),
        post("z9y8x7", "Pumpkin Season", "1 month ago", "<p>&#x1F383; Pumpkins are back for October.</p>"),
    ]

    private static func post(_ id: String, _ title: String, _ date: String, _ content: String,
                             edited: String? = nil) -> [String: Any] {
        var post: [String: Any] = ["id": id, "title": title, "content": content, "date": date]
        post["edited"] = edited.map { $0 as Any } ?? false
        post["author"] = ["username": "zach", "uuid": "55555555-5555-5555-5555-555555555555", "is_admin": true,
                          "pfp": picture, "default_pfp": true] as [String: Any]
        return post
    }

    /// updates.php's answer: by ?page=, or by ?post=.
    private static func updates(_ url: URL) -> Data {
        var reply: [String: Any] = ["total": posts.count, "last_checked": Int(Date().timeIntervalSince1970)]
        let index: Int?
        if let id = SiteURLs.queryValue("post", in: url) {
            index = posts.firstIndex { $0["id"] as? String == id }
        } else {
            let page = Int(SiteURLs.queryValue("page", in: url) ?? "") ?? 0
            index = posts.indices.contains(page) ? page : nil
        }
        if let index {
            reply.merge(posts[index]) { _, post in post }
        }
        reply["found"] = index != nil
        reply["page"] = index ?? 0
        return json(reply)
    }

    private static func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    /// A friend, as both the dashboard and a profile list one.
    private static func friend(_ name: String, _ id: String, state: String?, label: String?) -> [String: Any] {
        var friend: [String: Any] = ["username": name, "uuid": id, "id": id, "pfp": picture, "default_pfp": true,
                                     "relation": "friends", "is_you": false]
        friend["state"] = state.map { $0 as Any } ?? NSNull()
        friend["label"] = label.map { $0 as Any } ?? NSNull()
        return friend
    }

    private static let friends = [
        friend("pal", "22222222-2222-2222-2222-222222222222", state: "online", label: "Online"),
        friend("spinmaster", "33333333-3333-3333-3333-333333333333", state: "idle", label: "Idle"),
        friend("flapjack", "66666666-6666-6666-6666-666666666666", state: "offline", label: "Last seen 2h ago"),
        friend("towerqueen", "77777777-7777-7777-7777-777777777777", state: "offline", label: "Last seen yesterday"),
    ]

    /// Two months of lifetime spins, a busier day now and then.
    private static var spinHistory: [[String: Any]] {
        let calendar = Calendar(identifier: .gregorian)
        let today = calendar.startOfDay(for: Date())
        var total = 200_000
        return (0..<60).reversed().map { back -> [String: Any] in
            let day = calendar.date(byAdding: .day, value: -back, to: today)!
            total += back % 7 == 0 ? 4_000 : 900 + (back * 37) % 700
            let parts = calendar.dateComponents([.year, .month, .day], from: day)
            let date = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
            return ["date": date, "spins": total]
        }
    }

    static var dashboard: [String: Any] {
        let account: [String: Any] = ["username": "tester", "uuid": "11111111-1111-1111-1111-111111111111",
                                      "pfp": picture, "has_custom_pfp": false, "email_verified": true, "days": 412]
        let spin: [String: Any] = ["lifetime": 280_412, "prestige": 37, "ascends": 2, "spins": 51_000, "progress": 37.0]
        let flappy: [String: Any] = ["high": 41, "recent": 23, "played": 96, "progress": 56.1]
        let tower: [String: Any] = ["high": 18, "recent": 12, "played": 40, "progress": 66.7]
        let xp: [String: Any] = ["total": 733, "rank": "Grand Empanada", "icon": "🔥", "next": 1000,
                                 "next_rank": "Eldest Empanada", "progress": 46.6]
        let friendsCard: [String: Any] = ["total": 6, "online": 1, "pending": 1, "list": friends]
        var dashboard: [String: Any] = ["ok": true, "api": 1, "peppers": 128, "pumpkins": 4, "pumpkin_season": true]
        dashboard["account"] = account
        dashboard["spin"] = spin
        dashboard["flappy"] = flappy
        dashboard["tower"] = tower
        dashboard["xp"] = xp
        dashboard["friends"] = friendsCard
        dashboard["spin_history"] = spinHistory
        dashboard["generated"] = Int(Date().timeIntervalSince1970)
        return dashboard
    }

    static var leaderboard: [String: Any] {
        let names = ["empanada", "spinmaster", "tester", "pal", "flapjack", "towerqueen", "shy", "newbie",
                     "luckyloop", "crunchy"]
        /// The top ten, "shy" keeping a private profile, and the board's own
        /// numbers for each.
        func rows(_ best: Int, _ step: Int, _ extra: (Int) -> [String: Any]) -> [[String: Any]] {
            names.enumerated().map { index, name in
                var row: [String: Any] = ["rank": index + 1, "id": String(format: "%04X", index + 1),
                                          "username": name, "pfp": picture, "default_pfp": true]
                row["private"] = name == "shy"
                if name != "shy" { row["score"] = best - index * step }
                for (key, value) in extra(index) { row[key] = value }
                return row
            }
        }
        var board: [String: Any] = ["ok": true, "api": 1, "you": "0003", "age": 5, "ttl": 45]
        board["spin"] = rows(900_000, 70_000) { index in
            let ascends = 5 - index / 2
            let prestige = 90 - index * 7
            return ["ascends": ascends, "prestige": prestige]
        }
        board["flappy"] = rows(120, 9) { index in ["recent": 30 - index] }
        board["tower"] = rows(60, 4) { index in ["recent": 20 - index] }
        board["generated"] = Int(Date().timeIntervalSince1970)
        return board
    }

    static var account: [String: Any] {
        var profile: [String: Any] = ["id": 42, "username": "tester", "email": "tester@example.com",
                                      "email_verified": true, "pfp": picture, "pfp_small": picture,
                                      "has_custom_pfp": false, "two_factor": true, "passkeys": 1]
        profile["created_at"] = "2025-09-06 00:07:58"
        profile["birthday"] = "2000-08-02"
        profile["star_sign"] = "Leo"
        profile["connections"] = ["google"]
        let settings: [String: Int] = ["publicaccount": 1, "starsign": 1, "allownf": 1, "analytics": 1, "theme": 0,
                                       "promoemails": 0, "otheremails": 1, "recapemails": 1, "newsignins": 1]
        var account: [String: Any] = ["ok": true, "api": 1, "has_birthday": true, "csrf": "screenshots"]
        account["account"] = profile
        account["settings"] = settings
        return account
    }

    static var profile: [String: Any] {
        var player: [String: Any] = ["id": "11111111-1111-1111-1111-111111111111", "username": "tester",
                                     "pfp": picture, "default_pfp": true, "is_self": true, "admin": false,
                                     "supporter": true, "private": false, "email_verified": true, "days": 412]
        player["member_since"] = "2025-09-06 00:07:58"
        player["presence"] = ["state": "online", "label": "Online"]
        player["bio"] = "Spinning since day one."
        player["star_sign"] = ["name": "Leo", "symbol": "♌", "blurb": "Fierce and ready to win. Leos are fun."]

        let breakdown: [[String: Any]] = [
            ["label": "Lifetime Spins", "xp": 429, "percent": 58],
            ["label": "Ascensions", "xp": 250, "percent": 34],
            ["label": "Flappy", "xp": 54, "percent": 8],
        ]
        var xp: [String: Any] = ["total": 733, "rank": "Grand Empanada", "icon": "🔥", "range": "500 - 1,000 XP",
                                 "next": 1000, "next_rank": "Eldest Empanada", "progress": 46.6]
        xp["breakdown"] = breakdown

        var stats: [String: Any] = ["pumpkins": 4, "pumpkin_season": true]
        stats["spin"] = ["lifetime": 280_412, "current": 51_000, "ascends": 2, "prestige": 37]
        stats["flappy"] = ["high": 41, "played": 96, "recent": 23]
        stats["tower"] = ["high": 18, "played": 40, "recent": 12, "best_streak": 6, "perfects": 31]
        stats["peppers"] = ["current": 128, "lifetime": 410]

        var request = friend("empfan", "44444444-4444-4444-4444-444444444444", state: nil, label: nil)
        request["relation"] = "incoming"
        let friendsCard: [String: Any] = ["total": 6, "pending": 1, "list": [request] + friends]

        var profile: [String: Any] = ["ok": true, "api": 1, "csrf": "screenshots"]
        profile["profile"] = player
        profile["relationship"] = ["state": "self", "accepts_requests": true] as [String: Any]
        profile["xp"] = xp
        profile["stats"] = stats
        profile["friends"] = friendsCard
        return profile
    }
}
