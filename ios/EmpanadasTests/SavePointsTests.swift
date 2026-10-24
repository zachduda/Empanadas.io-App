import XCTest
@testable import Empanadas

/// Manage Game Data: what /v2/gamehistory.php sends (tests/gamehistory_test.php
/// and tests/gamehistory_e2e.php on the site), how a save point compares with
/// the account now, and what a refusal tells the player.
final class SavePointsTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: - The list

    func testReadsAPageOfSavePoints() throws {
        let page = try decode(SavePointsPage.self, """
            {"result":true,
             "current":{"prestige":12,"ascensions":3,"manual_spins":45210,"peppers":1200,"flappy_best":44,
                        "tower_best":null},
             "points":[
               {"id":905,"date":"2026-10-17 21:18:11","label":"Oct 17, 2026 9:18 PM","prestige":30,"ascensions":3,
                "manual_spins":40000,"peppers":900,"flappy_best":50,"tower_best":12,"full":true,"restorable":true,
                "ago":"3 days ago"},
               {"id":640,"date":"2026-09-01 08:00:00","label":"Sep 1, 2026 8:00 AM","prestige":72,"ascensions":1,
                "manual_spins":19000,"peppers":null,"flappy_best":null,"tower_best":null,"full":false,
                "restorable":false,"ago":""}],
             "more":true,"before":640}
            """)
        XCTAssertEqual(page.current.manualSpins, 45210)
        XCTAssertEqual(page.current.flappyBest, 44)
        XCTAssertNil(page.current.towerBest, "no Tower save")
        XCTAssertEqual(page.points.map(\.id), [905, 640])

        let newest = page.points[0]
        XCTAssertEqual(newest.label, "Oct 17, 2026 9:18 PM")
        XCTAssertEqual(newest.ago, "3 days ago")
        XCTAssertEqual(newest.stats.prestige, 30)
        XCTAssertEqual(newest.stats[.towerBest], 12)
        XCTAssertTrue(newest.full)
        XCTAssertTrue(newest.restorable)

        let oldest = page.points[1]
        XCTAssertFalse(oldest.full)
        XCTAssertFalse(oldest.restorable)
        XCTAssertNil(oldest.stats.peppers)
        XCTAssertEqual(page.before, 640)
    }

    func testTheOldestPageHasNoNextOne() throws {
        let last = try decode(SavePointsPage.self, #"{"result":true,"current":{},"points":[],"more":false,"before":null}"#)
        XCTAssertNil(last.before)
        XCTAssertEqual(last.points, [])
        XCTAssertEqual(last.current, SaveStats())

        let stray = try decode(SavePointsPage.self, #"{"result":true,"points":[],"more":false,"before":12}"#)
        XCTAssertNil(stray.before, "only a page that says there is more has a next one")
    }

    func testOneBadRowDoesNotTakeTheRest() throws {
        let page = try decode(SavePointsPage.self, """
            {"result":true,"current":{"prestige":1},
             "points":[{"id":"x"},{"label":"no id"},{"id":7,"prestige":"lots","manual_spins":9}]}
            """)
        XCTAssertEqual(page.points.map(\.id), [7])
        XCTAssertEqual(page.points[0].stats.prestige, 0, "a number that isn't one reads as 0")
        XCTAssertEqual(page.points[0].stats.manualSpins, 9)
        XCTAssertTrue(page.points[0].restorable, "restorable unless the site says otherwise")
    }

    func testReadsARestore() throws {
        let restored = try decode(RestoredSave.self, """
            {"result":true,"full":false,"backup":true,"current":{"prestige":4,"manual_spins":10,"peppers":3}}
            """)
        XCTAssertFalse(restored.full)
        XCTAssertTrue(restored.backup)
        XCTAssertEqual(restored.current.prestige, 4)
        XCTAssertEqual(restored.current.peppers, 3)
    }

    // MARK: - Comparing

    func testComparesWithNow() {
        XCTAssertEqual(SaveTrend(5, now: 3), .higher)
        XCTAssertEqual(SaveTrend(3, now: 5), .lower)
        XCTAssertEqual(SaveTrend(4, now: 4), .same)
        XCTAssertEqual(SaveTrend(nil, now: 0), .same, "a game with no save counts as 0")
        XCTAssertEqual(SaveTrend(2, now: nil), .higher)
    }

    func testASpinOnlySavePointLeavesTheRestAlone() {
        var point = SavePoint(id: 1)
        point.full = false
        XCTAssertEqual(SaveStat.allCases.filter(point.changes), [.prestige, .ascensions, .manualSpins])
        point.full = true
        XCTAssertEqual(SaveStat.allCases.filter(point.changes), SaveStat.allCases)
    }

    func testReadsTheSitesTime() throws {
        // 9:18 PM in New York in October (EDT, UTC-4): 1:18 AM UTC the next day.
        let date = try XCTUnwrap(SavePoint.siteDate("2026-10-17 21:18:11"))
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let parts = utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        XCTAssertEqual([parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second],
                       [2026, 10, 18, 1, 18, 11])

        var point = SavePoint(id: 1)
        point.date = "2026-10-17 21:18:11"
        XCTAssertEqual(point.savedAt, date)

        XCTAssertNil(SavePoint.siteDate(""))
        XCTAssertNil(SavePoint.siteDate("yesterday"))
        XCTAssertNil(SavePoint.siteDate("2026-13-01 00:00:00"))
        XCTAssertNil(SavePoint.siteDate("2026-10-17"))
    }

    // MARK: - The endpoint

    func testAsksForTheRightPage() {
        XCTAssertEqual(SiteURLs.gameHistory.absoluteString, "https://empanadas.io/v2/gamehistory.php")
        XCTAssertEqual(SiteURLs.gameHistory(before: 640).absoluteString,
                       "https://empanadas.io/v2/gamehistory.php?before=640")
        XCTAssertEqual(SiteURLs.gameHistory(before: nil), SiteURLs.gameHistory)
        XCTAssertEqual(SiteURLs.gameHistory(before: 0), SiteURLs.gameHistory)
    }

    func testReadsTheEndpointsAnswers() throws {
        let ok = Data(#"{"result":true,"points":[]}"#.utf8)
        XCTAssertEqual(try AccountAPI.gameHistoryBody(ok, status: 200), ok)

        func failure(_ body: String, status: Int = 200) -> AccountError? {
            do {
                _ = try AccountAPI.gameHistoryBody(Data(body.utf8), status: status)
                return nil
            } catch {
                return error as? AccountError
            }
        }
        XCTAssertEqual(failure(#"{"result":false,"reason":"no_session"}"#), .signedOut)
        XCTAssertEqual(failure(#"{"result":false,"reason":"csrf"}"#), .staleToken, "tried again with a fresh token")
        XCTAssertEqual(failure(#"{"result":false,"reason":"cooldown","wait":12}"#),
                       .server(SavePointsReason.cooldown(12)))
        XCTAssertEqual(failure(#"{"result":false,"reason":"anti_cheat"}"#),
                       .server(SavePointsReason.message("anti_cheat")))
        XCTAssertEqual(failure("<html>Not Found</html>", status: 404), .unavailable("HTTP 404"),
                       "a site without the endpoint yet")
        XCTAssertEqual(failure("<html>Bad Gateway</html>", status: 502), .server(AccountAPI.serverErrorMessage(502)))
        XCTAssertEqual(failure("", status: 429), .rateLimited)
    }

    func testExplainsARefusal() {
        XCTAssertEqual(SavePointsReason.message("anti_cheat"),
                       "That save point is from before an anti-cheat reset, so it can't be restored.")
        XCTAssertEqual(SavePointsReason.message("unavailable"),
                       "Accounts are under maintenance right now. Try again in a little while.")
        let review = "This is a demo account for App Review, so changes aren't saved."
        XCTAssertEqual(SavePointsReason.message(review), review, "the App Review account's answer is a sentence already")
        XCTAssertEqual(SavePointsReason.message("stmt_fail"), "Something went wrong on our end. Try again in a moment.")
        XCTAssertEqual(SavePointsReason.cooldown(1), "You just restored a save. Give it 1 more second and try again.")
        XCTAssertEqual(SavePointsReason.cooldown(12), "You just restored a save. Give it 12 more seconds and try again.")
        XCTAssertEqual(SavePointsReason.cooldown(0), SavePointsReason.cooldown(1))
    }
}
