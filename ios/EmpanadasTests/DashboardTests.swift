import XCTest
@testable import Empanadas

/// The native dashboard and leaderboard's data: what /v2/ios/dashboard.php
/// and /v2/ios/leaderboard.php send (tests/iosapp_test.php on the site), the
/// Spin Progress chart's arithmetic, and what is kept for offline use.
final class DashboardTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private var newYork: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }

    private func day(_ text: String) -> Date {
        let parts = text.split(separator: "-").map { Int($0)! }
        return newYork.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))!
    }

    // MARK: - Dashboard

    func testReadsTheDashboardAnswer() throws {
        let dashboard = try decode(Dashboard.self, """
            {"ok":true,"api":1,
             "account":{"username":"tester","uuid":"ab-12","pfp":"/Content/Images/ProfilePics/lg/me.jpeg",
                        "has_custom_pfp":true,"email_verified":false,"days":9},
             "peppers":12,"pumpkins":4,"pumpkin_season":true,
             "spin":{"lifetime":280000,"prestige":3,"ascends":1,"spins":50000,"progress":2.5},
             "flappy":{"high":40,"recent":10,"played":9,"progress":25.0},
             "tower":{"high":0,"recent":0,"played":0,"progress":0},
             "xp":{"total":10500,"rank":"Seasoned Empanada","icon":"💎","next":null,"next_rank":null,"progress":100.0},
             "friends":{"total":3,"online":1,"pending":2,"list":[
                {"username":"pal","uuid":"cd-34","pfp":"/x.png","default_pfp":false,"state":"online","label":"Online"}]},
             "spin_history":[{"date":"2026-10-09","spins":279000},{"date":"2026-10-10","spins":280000}],
             "generated":1760000000}
            """)
        XCTAssertEqual(dashboard.account.username, "tester")
        XCTAssertFalse(dashboard.account.emailVerified)
        XCTAssertEqual(dashboard.account.days, 9)
        XCTAssertEqual(dashboard.pictureURL?.absoluteString, "https://empanadas.io/Content/Images/ProfilePics/lg/me.jpeg")
        XCTAssertEqual(dashboard.peppers, 12)
        XCTAssertTrue(dashboard.pumpkinSeason)
        XCTAssertEqual(dashboard.spin.lifetime, 280000)
        XCTAssertEqual(dashboard.spin.progress, 2.5, accuracy: 0.001)
        XCTAssertEqual(dashboard.flappy.high, 40)
        XCTAssertEqual(dashboard.score(for: .flappy)?.progress ?? 0, 25, accuracy: 0.001)
        XCTAssertNil(dashboard.score(for: .spin), "spin has its own numbers")
        XCTAssertEqual(dashboard.tower.progress, 0, accuracy: 0.001, "a whole number decodes as a progress too")
        XCTAssertEqual(dashboard.xp.icon, "💎")
        XCTAssertNil(dashboard.xp.next, "the top rank has nowhere to go")
        XCTAssertEqual(dashboard.friends.pending, 2)
        XCTAssertEqual(dashboard.friends.list.first?.state, "online")
        XCTAssertEqual(dashboard.spinHistory.count, 2)
    }

    func testABareDashboardStillLoads() throws {
        let dashboard = try decode(Dashboard.self, #"{"ok":true,"account":{"username":"new"}}"#)
        XCTAssertEqual(dashboard.account.username, "new")
        XCTAssertTrue(dashboard.account.emailVerified, "no nudge on a guess")
        XCTAssertNil(dashboard.pictureURL)
        XCTAssertEqual(dashboard.spin.lifetime, 0)
        XCTAssertEqual(dashboard.friends.list, [])
        XCTAssertEqual(dashboard.spinHistory, [])
    }

    func testOneBadChartDayDoesNotTakeTheRest() throws {
        let dashboard = try decode(Dashboard.self, """
            {"account":{"username":"x"},"spin_history":[
              {"date":"2026-10-01","spins":5},{"date":3},{"spins":"lots"}]}
            """)
        XCTAssertEqual(dashboard.spinHistory, [Dashboard.SpinDay(date: "2026-10-01", spins: 5)])
    }

    func testADashboardWithoutAnAccountIsNotOne() {
        XCTAssertThrowsError(try decode(Dashboard.self, #"{"ok":true,"peppers":3}"#))
    }

    // MARK: - Spin Progress chart

    func testOnePointADayInDateOrderWithWhatEachEarned() {
        let points = SpinHistory.points([
            .init(date: "2026-10-01", spins: 100),
            .init(date: "2026-10-03", spins: 150),
            .init(date: "2026-10-02", spins: 120),
            .init(date: "yesterday", spins: 999),
        ], calendar: newYork)
        XCTAssertEqual(points.map(\.date), [day("2026-10-01"), day("2026-10-02"), day("2026-10-03")])
        XCTAssertEqual(points.map(\.total), [100, 120, 150])
        XCTAssertEqual(points.map(\.gained), [0, 20, 30])
    }

    func testANewTotalBelowTheLastEarnsNothingRatherThanLess() {
        let points = SpinHistory.points([.init(date: "2026-10-01", spins: 100), .init(date: "2026-10-02", spins: 90)],
                                        calendar: newYork)
        XCTAssertEqual(points.map(\.gained), [0, 0])
    }

    func testRangesAndWhatWasEarnedInThem() {
        let points = SpinHistory.points([
            .init(date: "2026-08-01", spins: 10),
            .init(date: "2026-10-01", spins: 100),
            .init(date: "2026-10-05", spins: 160),
            .init(date: "2026-10-10", spins: 200),
        ], calendar: newYork)
        let now = day("2026-10-10")

        let week = SpinHistory.points(points, in: .week, now: now, calendar: newYork)
        XCTAssertEqual(week.map(\.total), [160, 200])
        // From where the week began (Oct 1's total), not its first point.
        XCTAssertEqual(SpinHistory.gained(points, in: .week, now: now, calendar: newYork), 100)
        XCTAssertEqual(SpinHistory.points(points, in: .month, now: now, calendar: newYork).count, 3)
        XCTAssertEqual(SpinHistory.points(points, in: .all, now: now, calendar: newYork).count, 4)
        XCTAssertEqual(SpinHistory.gained(points, in: .all, now: now, calendar: newYork), 190)
        XCTAssertEqual(SpinHistory.gained([], in: .month, now: now, calendar: newYork), 0)
    }

    // MARK: - Leaderboard

    private let boardJSON = """
        {"ok":true,"api":1,
         "spin":[
           {"rank":1,"id":"AB12","username":"top","pfp":"/Content/Images/ProfilePics/sm/a.jpeg",
            "default_pfp":false,"private":false,"score":5000,"ascends":2,"prestige":7},
           {"rank":2,"id":"cd34","username":"shy","pfp":"/Content/Images/defaultpfp.png",
            "default_pfp":true,"private":true}],
         "flappy":[{"rank":1,"id":"ef56","username":"bird","private":false,"score":80,"recent":12}],
         "tower":[{"rank":1,"id":"gh78","username":"stack","private":false,"score":30,"recent":1}],
         "you":"ab12","generated":1760000000,"age":10,"ttl":45}
        """

    func testReadsTheLeaderboardAnswer() throws {
        let board = try decode(Leaderboard.self, boardJSON)
        let top = try XCTUnwrap(board.rows(for: .spin).first)
        XCTAssertEqual(top.uuid, "AB12")
        XCTAssertEqual(top.score, 5000)
        XCTAssertTrue(board.isYou(top), "matched without regard to case, as leaderboard.js does")
        XCTAssertEqual(top.detail(for: .spin), "2 ascensions · Prestige 7")
        XCTAssertEqual(top.pictureURL?.absoluteString, "https://empanadas.io/Content/Images/ProfilePics/sm/a.jpeg")

        let shy = board.rows(for: .spin)[1]
        XCTAssertTrue(shy.isPrivate)
        XCTAssertNil(shy.score, "a private profile has no score to show")
        XCTAssertEqual(shy.detail(for: .spin), "Private profile")
        XCTAssertFalse(board.isYou(shy))

        XCTAssertEqual(board.rows(for: .flappy).first?.detail(for: .flappy), "Last run: 12")
        XCTAssertEqual(board.rows(for: .tower).first?.detail(for: .tower), "Last run: 1 floor")
        XCTAssertEqual(board.generatedAt, Date(timeIntervalSince1970: 1_760_000_000))
    }

    func testTheBoardIsAskedForAgainWhenTheSiteHasANewOne() throws {
        XCTAssertEqual(try decode(Leaderboard.self, boardJSON).pollInterval, 37, "45 - 10, and a little")
        XCTAssertEqual(try decode(Leaderboard.self, #"{"ttl":45,"age":44}"#).pollInterval, 15, "never sooner")
        XCTAssertEqual(try decode(Leaderboard.self, #"{"ttl":600,"age":0}"#).pollInterval, 120, "never later")
    }

    func testAnEmptyBoardIsNotAnError() throws {
        let board = try decode(Leaderboard.self, #"{"ok":true}"#)
        XCTAssertEqual(board.rows(for: .tower), [])
        XCTAssertNil(board.generatedAt)
        XCTAssertFalse(board.isYou(Leaderboard.Row()), "no player, no match")
    }

    // MARK: - Replies, URLs and offline copies

    func testIOSBodiesAndTheErrorsTheyStandFor() throws {
        let ok = Data(#"{"ok":true,"api":1}"#.utf8)
        XCTAssertEqual(try AccountAPI.iosBody(ok, reply: AccountAPI.iosReply(ok), status: 200), ok)

        let signedOut = Data(#"{"ok":false,"api":1,"reason":"no_session"}"#.utf8)
        XCTAssertThrowsError(try AccountAPI.iosBody(signedOut, reply: AccountAPI.iosReply(signedOut), status: 401)) {
            XCTAssertEqual($0 as? AccountError, .signedOut)
        }
        let broken = Data(#"{"ok":false,"api":1,"reason":"server_error"}"#.utf8)
        XCTAssertThrowsError(try AccountAPI.iosBody(broken, reply: AccountAPI.iosReply(broken), status: 500)) {
            XCTAssertEqual($0 as? AccountError, .unavailable("server_error"))
        }
        let nginx = Data("<html>404</html>".utf8)
        XCTAssertThrowsError(try AccountAPI.iosBody(nginx, reply: AccountAPI.iosReply(nginx), status: 404)) {
            XCTAssertEqual($0 as? AccountError, .unavailable("HTTP 404"), "an endpoint not deployed yet")
        }
    }

    func testTheSavedAccountHasNoToken() throws {
        let reply = Data("""
            {"ok":true,"account":{"username":"tester"},
             "settings":{"publicaccount":1,"starsign":1,"allownf":1,"analytics":1,"theme":0,
                         "promoemails":1,"otheremails":1,"recapemails":1,"newsignins":1},
             "csrf":"secret"}
            """.utf8)
        let saved = try JSONDecoder().decode(AccountSnapshot.self, from: AccountAPI.withoutToken(reply))
        XCTAssertEqual(saved.csrf, "", "still decodes, with nothing to send")
        XCTAssertEqual(saved.username, "tester")
        XCTAssertEqual(AccountAPI.withoutToken(Data("not json".utf8)), Data("not json".utf8))
    }

    func testPicturesAndProfileLinks() {
        XCTAssertEqual(SiteURLs.resolve("/Content/Images/a.png")?.absoluteString, "https://empanadas.io/Content/Images/a.png")
        XCTAssertEqual(SiteURLs.resolve("https://cdn.example/a.png")?.absoluteString, "https://cdn.example/a.png")
        XCTAssertNil(SiteURLs.resolve("http://example.com/a.png"), "never plain http")
        XCTAssertNil(SiteURLs.resolve(""))
        XCTAssertNil(SiteURLs.resolve(nil))
        XCTAssertEqual(SiteURLs.playerProfile(id: "AB-12").absoluteString, "https://empanadas.io/v2/profile/ab-12")
        XCTAssertEqual(SiteURLs.findFriends.absoluteString, "https://empanadas.io/v2/profile?search=1")
        XCTAssertEqual(SiteURLs.iosDashboard.path(), "/v2/ios/dashboard.php", "under /v2/, where the session cookie goes")
        XCTAssertEqual(SiteURLs.iosLeaderboard.path(), "/v2/ios/leaderboard.php")
    }

    func testOfflineCopiesRoundTripAndGoAtSignOut() throws {
        OfflineStore.save(Data(boardJSON.utf8), as: .leaderboard)
        let saved = try XCTUnwrap(OfflineStore.load(Leaderboard.self, .leaderboard))
        XCTAssertEqual(saved.value.rows(for: .spin).count, 2)
        let savedAt = try XCTUnwrap(saved.savedAt)
        XCTAssertLessThan(Date().timeIntervalSince(savedAt), 60)

        OfflineStore.clear()
        XCTAssertNil(OfflineStore.load(.leaderboard))
    }

    func testWhichFailuresMeanNoConnection() {
        XCTAssertTrue(WebPage.isConnectionError(NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)))
        XCTAssertTrue(WebPage.isConnectionError(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)))
        XCTAssertFalse(WebPage.isConnectionError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadServerResponse)))
        XCTAssertFalse(WebPage.isConnectionError(NSError(domain: "WebKitErrorDomain", code: 102)))
    }

    // MARK: - Page colours

    func testPageColoursAsGetComputedStyleWritesThem() throws {
        let rgb = try XCTUnwrap(CSSColor("rgb(47, 49, 63)"))
        XCTAssertEqual(rgb.red, 47 / 255, accuracy: 0.0001)
        XCTAssertEqual(rgb.green, 49 / 255, accuracy: 0.0001)
        XCTAssertEqual(rgb.blue, 63 / 255, accuracy: 0.0001)
        XCTAssertEqual(rgb.alpha, 1)

        XCTAssertTrue(try XCTUnwrap(CSSColor("rgba(0, 0, 0, 0)")).isTransparent)
        XCTAssertEqual(try XCTUnwrap(CSSColor("rgb(47 49 63 / 50%)")).alpha, 0.5, accuracy: 0.0001)
        XCTAssertEqual(CSSColor("#2F313F"), CSSColor(red: 47 / 255, green: 49 / 255, blue: 63 / 255))
        XCTAssertEqual(CSSColor("#fff"), CSSColor(red: 1, green: 1, blue: 1))
        XCTAssertEqual(try XCTUnwrap(CSSColor("rgb(300, -4, 12)")).red, 1, "clamped")
    }

    func testAnythingElseIsNotAColour() {
        XCTAssertNil(CSSColor("blue"))
        XCTAssertNil(CSSColor("rgb(1, 2)"))
        XCTAssertNil(CSSColor("rgb(a, b, c)"))
        XCTAssertNil(CSSColor("#12"))
        XCTAssertNil(CSSColor(""))
        XCTAssertNil(CSSColor("rgb(" + String(repeating: "1,", count: 50) + ")"))
    }
}
