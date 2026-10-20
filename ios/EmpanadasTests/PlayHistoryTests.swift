import XCTest
@testable import Empanadas

/// When each game was last played in the app (PlayHistory): what the Games
/// tab's "Played 2 hours ago" and Jump Back In read.
final class PlayHistoryTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "PlayHistoryTests"
    private let english = Locale(identifier: "en_US")

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testKeepsWhenEachGameWasPlayed() {
        let flappy = Date(timeIntervalSince1970: 1_760_000_000)
        let tower = flappy.addingTimeInterval(-3600)
        PlayHistory.save([.flappy: flappy, .tower: tower], to: defaults)
        XCTAssertEqual(PlayHistory.load(from: defaults), [.flappy: flappy, .tower: tower])
    }

    func testNothingPlayedIsNothingKept() {
        XCTAssertEqual(PlayHistory.load(from: defaults), [:])
        PlayHistory.save([.spin: Date()], to: defaults)
        PlayHistory.clear(defaults)
        XCTAssertEqual(PlayHistory.load(from: defaults), [:], "signed out: the next account starts afresh")
    }

    func testAGameNoLongerInTheAppIsLeftOut() {
        let date = Date(timeIntervalSince1970: 1_760_000_000)
        defaults.set(["flappy": date, "snake": date, "tower": "yesterday"] as [String: Any],
                     forKey: Preferences.playHistoryKey)
        XCTAssertEqual(PlayHistory.load(from: defaults), [.flappy: date])
    }

    func testJumpBackInIsTheGamePlayedLast() {
        let now = Date()
        let latest = PlayHistory.latest([.spin: now.addingTimeInterval(-60), .tower: now,
                                         .flappy: now.addingTimeInterval(-7200)])
        XCTAssertEqual(latest?.game, .tower)
        XCTAssertEqual(latest?.date, now)
        XCTAssertNil(PlayHistory.latest([:]), "nothing to jump back into yet")
    }

    func testSaysHowLongAgo() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        XCTAssertEqual(PlayHistory.label(now.addingTimeInterval(-2 * 3600), now: now, locale: english),
                       "Played 2 hours ago")
        XCTAssertEqual(PlayHistory.label(now.addingTimeInterval(-5 * 60), now: now, locale: english),
                       "Played 5 minutes ago")
    }

    func testTheLastMinuteIsJustNow() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        XCTAssertEqual(PlayHistory.label(now, now: now, locale: english), "Played just now")
        XCTAssertEqual(PlayHistory.label(now.addingTimeInterval(-59), now: now, locale: english), "Played just now")
        XCTAssertEqual(PlayHistory.label(now.addingTimeInterval(3600), now: now, locale: english), "Played just now",
                       "a clock set back is not \"in 1 hour\"")
    }

    func testQuickActionsPutTheGamePlayedLastFirst() {
        let now = Date()
        XCTAssertEqual(PlayHistory.ordered([:]), [.spin, .flappy, .tower], "nothing played: the usual order")
        XCTAssertEqual(PlayHistory.ordered([.tower: now, .spin: now.addingTimeInterval(-60)]), [.tower, .spin, .flappy],
                       "the last first, then the rest played, then the others as usual")
    }

    // MARK: - The Home Screen widget

    func testTheWidgetIsToldEachGameItsNumbersAndWhenItWasPlayed() throws {
        let dashboard = try JSONDecoder().decode(Dashboard.self, from: Data("""
            {"account":{"username":"tester"},"flappy":{"high":41,"recent":23,"played":96}}
            """.utf8))
        let played = Date(timeIntervalSince1970: 1_760_000_000)
        let snapshot = HomeScreenWidget.snapshot(dashboard: dashboard, lastPlayed: [.flappy: played])

        XCTAssertEqual(snapshot.games.map(\.id), ["spin", "flappy", "tower"])
        let flappy = try XCTUnwrap(snapshot.games.first { $0.id == "flappy" })
        XCTAssertEqual(flappy.title, "Flappy")
        XCTAssertEqual(flappy.tint, Game.flappy.tintHex)
        XCTAssertEqual(flappy.stats.first, GamesSnapshot.Stat(label: "Best", text: GameStat.format(41)))
        XCTAssertEqual(flappy.lastPlayed, played)
        XCTAssertEqual(snapshot.featured?.id, "flappy", "the one to jump back into")
    }

    func testBeforeTheDashboardTheWidgetHasNoNumbers() {
        let snapshot = HomeScreenWidget.snapshot(dashboard: nil, lastPlayed: [:])
        XCTAssertTrue(snapshot.games.allSatisfy(\.stats.isEmpty))
        XCTAssertEqual(snapshot.featured?.id, "spin", "nothing played here yet: the first game")
    }

    func testTheWidgetReadsBackWhatTheAppWrote() throws {
        let snapshot = HomeScreenWidget.snapshot(dashboard: nil, lastPlayed: [.tower: Date(timeIntervalSince1970: 1_760_000_000)])
        let data = try XCTUnwrap(snapshot.encoded())
        XCTAssertEqual(GamesSnapshot.decode(data), snapshot)
        XCTAssertEqual(snapshot.encoded(), data, "the same snapshot, the same bytes: the widget is not reloaded for nothing")
        XCTAssertNil(GamesSnapshot.decode(Data("not json".utf8)))
        XCTAssertNil(GamesSnapshot.decode(nil), "signed out: nothing written")
    }

    func testAWidgetTapOpensTheGame() {
        XCTAssertEqual(GamesSnapshot.playURL("flappy").absoluteString, "empanadas-io://play/flappy")
        XCTAssertEqual(NativeRoute.of(deepLink: GamesSnapshot.playURL("flappy")), .game(.flappy))
        XCTAssertEqual(NativeRoute.of(deepLink: GamesSnapshot.homeURL), .home)
    }
}
