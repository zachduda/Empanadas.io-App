import XCTest
@testable import Empanadas

/// The native profiles and Find Friends: what /v2/ios/profile and
/// /v2/ios/search send (tests/iosapp_test.php on the site), the profile
/// ids account_edit.php takes, and the links that open these screens.
final class ProfileTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func url(_ string: String) -> URL { URL(string: string)! }

    // MARK: - Profiles

    /// The player's own, as the endpoint answered on a test database.
    private let myProfile = """
        {"ok":true,"api":1,"profile":{"id":"11111111-1111-1111-1111-111111111111","username":"me",
         "pfp":"/Content/Images/ProfilePics/lg/me.png","default_pfp":false,"is_self":true,"admin":false,
         "supporter":true,"private":false,"email_verified":true,"member_since":"2025-09-06 00:07:58","days":399,
         "presence":{"state":"online","label":"Online"},"bio":"Hi & welcome",
         "star_sign":{"name":"Leo","symbol":"♌","blurb":"Fierce and ready to win. Leos are fun."}},
         "relationship":{"state":"self","accepts_requests":true},
         "xp":{"total":733,"rank":"Grand Empanada","icon":"🔥","range":"500 - 1,000 XP","next":1000,
               "next_rank":"Eldest Empanada","progress":46.6,"breakdown":[
               {"label":"Lifetime Spins","xp":429,"percent":58},{"label":"Ascentions","xp":250,"percent":34}]},
         "stats":{"spin":{"lifetime":12000,"current":5000,"ascends":1,"prestige":3},"flappy":null,"tower":null,
                  "peppers":{"current":31,"lifetime":35},"pumpkins":0,"pumpkin_season":true},
         "friends":{"total":1,"pending":1,"list":[
           {"username":"empfan","id":"44444444-4444-4444-4444-444444444444","pfp":"/Content/Images/defaultpfp.png",
            "default_pfp":true,"relation":"incoming","state":null,"label":null,"is_you":false},
           {"username":"emp","id":"55555555-5555-5555-5555-555555555555","pfp":"/Content/Images/defaultpfp.png",
            "default_pfp":true,"relation":"outgoing","state":null,"label":null,"is_you":false},
           {"username":"pal","id":"22222222-2222-2222-2222-222222222222","pfp":"/Content/Images/defaultpfp.png",
            "default_pfp":true,"relation":"friends","state":"online","label":"Online","is_you":false}]},
         "csrf":"fbe3093522fe8a4a7b6f63ee369d11f5"}
        """

    func testReadsTheirOwnProfile() throws {
        let profile = try decode(PlayerProfile.self, myProfile)
        XCTAssertTrue(profile.isSelf)
        XCTAssertEqual(profile.relationship, .me)
        XCTAssertEqual(profile.player.username, "me")
        XCTAssertEqual(profile.player.pictureURL?.absoluteString, "https://empanadas.io/Content/Images/ProfilePics/lg/me.png")
        XCTAssertTrue(profile.player.supporter)
        XCTAssertEqual(profile.player.emailVerified, true)
        XCTAssertEqual(profile.player.bio, "Hi & welcome")
        XCTAssertEqual(profile.player.presence?.state, "online")
        XCTAssertEqual(profile.player.starSign?.symbol, "♌")
        XCTAssertEqual(profile.xp?.rank, "Grand Empanada")
        XCTAssertEqual(profile.xp?.breakdown.map(\.label), ["Lifetime Spins", "Ascentions"])
        XCTAssertEqual(profile.stats?.spin?.lifetime, 12000)
        XCTAssertNil(profile.stats?.flappy, "a game never played")
        XCTAssertEqual(profile.stats?.peppers.lifetime, 35)
        XCTAssertEqual(profile.csrf, "fbe3093522fe8a4a7b6f63ee369d11f5")
        XCTAssertEqual(profile.webURL?.absoluteString,
                       "https://empanadas.io/v2/profile/11111111-1111-1111-1111-111111111111")
    }

    func testSortsTheFriendsListIntoRequestsAndFriends() throws {
        let friends = try XCTUnwrap(try decode(PlayerProfile.self, myProfile).friends)
        XCTAssertEqual(friends.pending, 1)
        XCTAssertEqual(friends.incoming.map(\.username), ["empfan"])
        XCTAssertEqual(friends.outgoing.map(\.username), ["emp"])
        XCTAssertEqual(friends.accepted.map(\.username), ["pal"])
        XCTAssertEqual(friends.accepted.first?.label, "Online")
        XCTAssertNil(friends.incoming.first?.state, "requests have no presence")
    }

    func testAPrivateProfileHasOnlyTheName() throws {
        let profile = try decode(PlayerProfile.self, """
            {"ok":true,"profile":{"id":"33333333-3333-3333-3333-333333333333","username":"stranger",
             "pfp":"/Content/Images/defaultpfp.png","default_pfp":true,"is_self":false,"private":true,
             "email_verified":null,"member_since":null,"days":null,"presence":null,"bio":null,"star_sign":null},
             "relationship":{"state":"none","accepts_requests":false},
             "xp":null,"stats":null,"friends":null,"csrf":"x"}
            """)
        XCTAssertFalse(profile.isSelf)
        XCTAssertTrue(profile.player.isPrivate)
        XCTAssertEqual(profile.relationship, .stranger)
        XCTAssertFalse(profile.acceptsRequests)
        XCTAssertNil(profile.player.emailVerified)
        XCTAssertNil(profile.player.memberSinceMonth)
        XCTAssertNil(profile.xp)
        XCTAssertNil(profile.stats)
        XCTAssertNil(profile.friends)
    }

    func testABareProfileStillLoads() throws {
        let profile = try decode(PlayerProfile.self, #"{"ok":true,"profile":{"username":"new"}}"#)
        XCTAssertEqual(profile.player.username, "new")
        XCTAssertEqual(profile.relationship, .stranger)
        XCTAssertTrue(profile.acceptsRequests, "no refusal on a guess")
        XCTAssertEqual(profile.csrf, "")
        XCTAssertNil(profile.webURL)
    }

    func testAProfileWithoutAPlayerIsNotOne() {
        XCTAssertThrowsError(try decode(PlayerProfile.self, #"{"ok":true,"relationship":{"state":"friends"}}"#))
    }

    func testRelationshipsTheAppDoesNotKnowAreStrangers() throws {
        let profile = try decode(PlayerProfile.self, """
            {"profile":{"username":"x"},"relationship":{"state":"nemesis"},
             "friends":{"list":[{"username":"y","relation":"frenemies"},{"relation":3},"junk"]}}
            """)
        XCTAssertEqual(profile.relationship, .stranger)
        XCTAssertEqual(profile.friends?.list.map(\.username), ["y", ""], "a bad row is dropped, not the list")
        XCTAssertEqual(profile.friends?.list.first?.relation, .stranger)
    }

    func testTheSiteSayingSelfIsBelievedOverTheRelationship() throws {
        let profile = try decode(PlayerProfile.self, #"{"profile":{"username":"me","is_self":true},"relationship":{"state":"none"}}"#)
        XCTAssertTrue(profile.isSelf)
    }

    func testAnEmptyBioIsNone() throws {
        let profile = try decode(PlayerProfile.self, #"{"profile":{"username":"x","bio":""}}"#)
        XCTAssertNil(profile.player.bio)
    }

    func testMemberSinceIsAMonth() throws {
        let player = try decode(PlayerProfile.self, #"{"profile":{"username":"x","member_since":"2024-01-02 03:04:05"}}"#).player
        let month = try XCTUnwrap(player.memberSinceMonth)
        XCTAssertTrue(month.contains("2024"), month)
        XCTAssertNil(try decode(PlayerProfile.self, #"{"profile":{"username":"x","member_since":"soon"}}"#).player.memberSinceMonth)
    }

    func testTheOfflineCopyHasNoToken() throws {
        let stripped = AccountAPI.withoutToken(Data(myProfile.utf8))
        let profile = try JSONDecoder().decode(PlayerProfile.self, from: stripped)
        XCTAssertEqual(profile.csrf, "")
        XCTAssertEqual(profile.player.username, "me")
    }

    // MARK: - Search

    func testReadsASearch() throws {
        let search = try decode(PlayerSearch.self, """
            {"ok":true,"api":1,"query":"emp","page":0,"has_more":true,"results":[
              {"id":"55555555-5555-5555-5555-555555555555","username":"emp","pfp":"/Content/Images/defaultpfp.png",
               "default_pfp":true,"admin":false,"supporter":false,"vip":false,"private":false,"relation":"outgoing",
               "accepts_requests":true},
              {"id":"44444444-4444-4444-4444-444444444444","username":"empfan","pfp":"/x.png","default_pfp":false,
               "admin":true,"supporter":false,"vip":false,"private":true,"relation":"none","accepts_requests":false},
              {"id":"broken"}]}
            """)
        XCTAssertEqual(search.query, "emp")
        XCTAssertTrue(search.hasMore)
        XCTAssertEqual(search.results.map(\.username), ["emp", "empfan"], "a result without a name is dropped")
        XCTAssertEqual(search.results[0].relation, .outgoing)
        XCTAssertEqual(search.results[1].relation, .stranger)
        XCTAssertTrue(search.results[1].admin)
        XCTAssertTrue(search.results[1].isPrivate)
        XCTAssertFalse(search.results[1].acceptsRequests)
        XCTAssertEqual(search.results[1].pictureURL?.absoluteString, "https://empanadas.io/x.png")
    }

    func testWhatCountsAsASearch() {
        // iosSearchTerm() on the site.
        XCTAssertEqual(PlayerSearch.term("emp"), "emp")
        XCTAssertEqual(PlayerSearch.term("  emp  "), "emp")
        XCTAssertNil(PlayerSearch.term("e"))
        XCTAssertNil(PlayerSearch.term(""))
        XCTAssertNil(PlayerSearch.term(String(repeating: "a", count: 17)))
        XCTAssertEqual(PlayerSearch.term("%e*m\"p%"), "emp")
        XCTAssertNil(PlayerSearch.term("%%"), "nothing left once the wildcards are out")
        XCTAssertNil(PlayerSearch.term("ééééééééé"), "the site counts bytes: 18")
    }

    func testSearchURLs() {
        XCTAssertEqual(SiteURLs.iosSearch("emp").absoluteString, "https://empanadas.io/v2/ios/search?q=emp")
        XCTAssertEqual(SiteURLs.iosSearch("a b", page: 2).absoluteString,
                       "https://empanadas.io/v2/ios/search?q=a%20b&p=2")
        XCTAssertEqual(SiteURLs.iosProfile().absoluteString, "https://empanadas.io/v2/ios/profile")
        XCTAssertEqual(SiteURLs.iosProfile(id: "").absoluteString, "https://empanadas.io/v2/ios/profile")
        XCTAssertEqual(SiteURLs.iosProfile(id: "AB-12").absoluteString, "https://empanadas.io/v2/ios/profile?id=ab-12")
    }

    // MARK: - Ids and changes

    func testProfileIdsAsAccountEditTakesThem() {
        XCTAssertEqual(PlayerID.raw("11111111-1111-1111-1111-11111111ABCD"), "1111111111111111111111111111abcd")
        XCTAssertEqual(PlayerID.raw("1111111111111111111111111111abcd"), "1111111111111111111111111111abcd")
        XCTAssertNil(PlayerID.raw("abc"))
        XCTAssertNil(PlayerID.raw("zz111111-1111-1111-1111-111111111111"))
        XCTAssertNil(PlayerID.raw(""))
        XCTAssertTrue(PlayerID.same("AB111111-1111-1111-1111-111111111111", "ab111111111111111111111111111111"))
        XCTAssertFalse(PlayerID.same("abc", "abc"), "not ids")
    }

    func testAStatusIsOneLine() {
        XCTAssertEqual(AccountAPI.bioLine("  hi\nthere\r\nyou  "), "hi there you")
        XCTAssertEqual(AccountAPI.bioLine("C++ & 100%"), "C++ & 100%")
        XCTAssertEqual(String(decoding: AccountAPI.formBody([("m", AccountAPI.bioLine("C++ & 100%"))]), as: UTF8.self),
                       "m=C%2B%2B%20%26%20100%25", "a + must not arrive as a space")
    }

    func testKnowsAStaleTokenInEitherWording() {
        XCTAssertTrue(AccountAPI.isStaleToken("csrf"))
        XCTAssertTrue(AccountAPI.isStaleToken("Your request has expired or was invalid.<br>Try reloading the page!"))
        XCTAssertFalse(AccountAPI.isStaleToken("A VPN has been detected. You cannot do this."))
        XCTAssertFalse(AccountAPI.isStaleToken(""))
    }

    // MARK: - Links

    func testProfileLinksOpenTheNativeProfile() {
        let id = "ab111111-1111-1111-1111-111111111111"
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/profile")), .profile(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/profile/")), .profile(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/profile/\(id)")), .profile(id))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/profile.php?id=\(id)")), .profile(id))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/profile?search=1")), .findFriends)
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/profile/\(id)?search=1")), .findFriends)
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/profile/abc")), "the web says there's no such player")
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/profile/\(id)/more")))
        XCTAssertNil(NativeRoute.of(url("https://example.com/v2/profile/\(id)")))
        XCTAssertNil(NativeRoute.of(url("http://empanadas.io/v2/profile")))
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/profilev2?u=\(id)")))
    }

    func testProfileDeepLinks() {
        let id = "ab111111-1111-1111-1111-111111111111"
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://profile")), .profile(nil))
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://profile/\(id)")), .profile(id))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://profile/nope")))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://profile/\(id)/x")))
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://friends")), .findFriends)
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://friends/x")))
    }
}
