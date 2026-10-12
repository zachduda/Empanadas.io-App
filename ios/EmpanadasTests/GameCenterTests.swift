import XCTest
@testable import Empanadas

/// What goes to Game Center (GameCenter): which leaderboard each game posts
/// to, which of the dashboard's numbers, and when.
final class GameCenterTests: XCTestCase {
    func testEachGameHasItsOwnLeaderboard() {
        XCTAssertEqual(Game.spin.gameCenterLeaderboardID, "io.empanadas.app.leaderboard.spin",
                       "the ID in App Store Connect: a change here needs a new leaderboard there")
        XCTAssertEqual(Game.flappy.gameCenterLeaderboardID, "io.empanadas.app.leaderboard.flappy")
        XCTAssertEqual(Game.tower.gameCenterLeaderboardID, "io.empanadas.app.leaderboard.tower")
        XCTAssertEqual(Set(Game.allCases.map(\.gameCenterLeaderboardID)).count, Game.allCases.count)
    }

    func testTheScoresAreTheOnesTheSiteRanksBy() throws {
        let dashboard = try JSONDecoder().decode(Dashboard.self, from: Data("""
            {"account":{"username":"tester"},
             "spin":{"lifetime":280000,"prestige":3,"ascends":1,"spins":50000},
             "flappy":{"high":40,"recent":10,"played":9},
             "tower":{"high":12,"recent":3,"played":4}}
            """.utf8))
        XCTAssertEqual(dashboard.leaderboardScore(for: .spin), 280000, "lifetime spins, not this prestige's")
        XCTAssertEqual(dashboard.leaderboardScore(for: .flappy), 40, "the best round, not the last")
        XCTAssertEqual(dashboard.leaderboardScore(for: .tower), 12)
    }

    func testOnlyWhatChangedIsReported() {
        let reported = ["spin": 1000, "flappy": 40]
        XCTAssertEqual(GameCenter.due(["spin": 1000, "flappy": 40, "tower": 12], reported: reported),
                       ["tower": 12], "a refresh with nothing new sends nothing")
        XCTAssertEqual(GameCenter.due(["spin": 1500, "flappy": 40], reported: reported), ["spin": 1500])
        XCTAssertEqual(GameCenter.due(["spin": 900], reported: reported), ["spin": 900],
                       "another account's lower score still goes; Game Center keeps the best")
    }

    func testAGameNotPlayedYetIsNotReported() {
        XCTAssertEqual(GameCenter.due(["spin": 0, "flappy": 0, "tower": 3], reported: [:]), ["tower": 3])
    }
}
