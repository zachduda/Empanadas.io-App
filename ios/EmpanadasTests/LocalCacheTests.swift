import XCTest
@testable import Empanadas

/// What the app keeps rather than ask the site again (Core/LocalCache.swift):
/// when each picture was last checked, the profiles read this session, and
/// the pace of the dashboard's refresh.
final class LocalCacheTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }
    private let start = Date(timeIntervalSince1970: 1_760_000_000)

    // MARK: - Pictures

    func testAPictureCheckedLatelyIsNotAskedAbout() {
        let picture = url("https://empanadas.io/Content/Images/ProfilePics/lg/abc.jpeg")
        var freshness = PictureFreshness()
        XCTAssertFalse(freshness.isFresh(picture, now: start), "never fetched")

        freshness.mark(picture, now: start)
        XCTAssertTrue(freshness.isFresh(picture, now: start.addingTimeInterval(60)))
        XCTAssertTrue(freshness.isFresh(picture, now: start.addingTimeInterval(PictureFreshness.maxAge - 1)))
        XCTAssertFalse(freshness.isFresh(picture, now: start.addingTimeInterval(PictureFreshness.maxAge)),
                       "a day on, the site is asked again")
        XCTAssertFalse(freshness.isFresh(url("https://empanadas.io/Content/Images/defaultpfp.png"), now: start),
                       "another picture")
    }

    func testAClockSetBackIsNotFresh() {
        let picture = url("https://empanadas.io/x.png")
        var freshness = PictureFreshness()
        freshness.mark(picture, now: start)
        XCTAssertFalse(freshness.isFresh(picture, now: start.addingTimeInterval(-3600)))
    }

    func testAPictureThatMayHaveChangedIsForgotten() {
        let mine = url("https://empanadas.io/Content/Images/ProfilePics/lg/me.png")
        let theirs = url("https://empanadas.io/Content/Images/ProfilePics/lg/abc.jpeg")
        var freshness = PictureFreshness()
        freshness.mark(mine, now: start)
        freshness.mark(theirs, now: start)
        freshness.forget(mine)
        XCTAssertFalse(freshness.isFresh(mine, now: start))
        XCTAssertTrue(freshness.isFresh(theirs, now: start))
    }

    func testFreshnessSurvivesBeingSaved() throws {
        var freshness = PictureFreshness()
        freshness.mark(url("https://empanadas.io/a.png"), now: start)
        let saved = try JSONEncoder().encode(freshness)
        XCTAssertEqual(try JSONDecoder().decode(PictureFreshness.self, from: saved), freshness)
    }

    func testTheOldestRecordsGoWhenThereAreTooMany() {
        var freshness = PictureFreshness()
        for index in 0...PictureFreshness.limit {
            freshness.mark(url("https://empanadas.io/p/\(index).png"), now: start.addingTimeInterval(Double(index)))
        }
        XCTAssertEqual(freshness.count, PictureFreshness.limit / 2)
        let now = start.addingTimeInterval(Double(PictureFreshness.limit))
        XCTAssertTrue(freshness.isFresh(url("https://empanadas.io/p/\(PictureFreshness.limit).png"), now: now),
                      "the newest is kept")
        XCTAssertFalse(freshness.isFresh(url("https://empanadas.io/p/0.png"), now: now), "the oldest is not")
    }

    // MARK: - Profiles

    private func profile(_ id: String, _ name: String) throws -> PlayerProfile {
        let json = #"{"ok":true,"profile":{"id":"\#(id)","username":"\#(name)"},"csrf":""}"#
        return try JSONDecoder().decode(PlayerProfile.self, from: Data(json.utf8))
    }

    @MainActor
    func testAProfileReadThisSessionIsKept() throws {
        ProfileCache.clear()
        defer { ProfileCache.clear() }
        let id = "22222222-2222-2222-2222-222222222222"
        XCTAssertNil(ProfileCache.entry(for: id))

        ProfileCache.keep(try profile(id, "pal"), for: id, now: start)
        XCTAssertEqual(ProfileCache.entry(for: id)?.profile.player.username, "pal")
        XCTAssertEqual(ProfileCache.entry(for: id)?.readAt, start)
        XCTAssertEqual(ProfileCache.entry(for: "22222222222222222222222222222222")?.profile.player.username, "pal",
                       "the same player, written without dashes")
        XCTAssertEqual(ProfileCache.entry(for: id.uppercased())?.profile.player.username, "pal")

        ProfileCache.forget(id)
        XCTAssertNil(ProfileCache.entry(for: id))
    }

    @MainActor
    func testProfilesGoWhenFriendsChangeOrThePlayerSignsOut() throws {
        defer { ProfileCache.clear() }
        let id = "22222222-2222-2222-2222-222222222222"
        ProfileCache.keep(try profile(id, "pal"), for: id)
        ProfileCache.clear()
        XCTAssertNil(ProfileCache.entry(for: id))
    }

    @MainActor
    func testOnlyTheLatestProfilesAreKept() throws {
        ProfileCache.clear()
        defer { ProfileCache.clear() }
        func id(_ index: Int) -> String { String(format: "%032lx", index + 1) }
        for index in 0...ProfileCache.limit {
            ProfileCache.keep(try profile(id(index), "p\(index)"), for: id(index))
        }
        XCTAssertNil(ProfileCache.entry(for: id(0)), "the one read longest ago")
        XCTAssertNotNil(ProfileCache.entry(for: id(1)))
        XCTAssertNotNil(ProfileCache.entry(for: id(ProfileCache.limit)))
    }

    // MARK: - The dashboard's pace

    func testTheDashboardSlowsDownWhileNothingChanges() {
        XCTAssertEqual(DashboardPace.interval(unchanged: 0), 60, "something just changed")
        XCTAssertEqual(DashboardPace.interval(unchanged: 1), 60)
        XCTAssertEqual(DashboardPace.interval(unchanged: 2), 60)
        XCTAssertEqual(DashboardPace.interval(unchanged: 3), 120)
        XCTAssertEqual(DashboardPace.interval(unchanged: 4), 240)
        XCTAssertEqual(DashboardPace.interval(unchanged: 5), 300, "never slower than five minutes")
        XCTAssertEqual(DashboardPace.interval(unchanged: 10_000), 300)
    }
}
