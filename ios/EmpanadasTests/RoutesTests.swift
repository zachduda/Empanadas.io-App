import XCTest
@testable import Empanadas

final class RoutesTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }

    func testGamesInEveryShapeTheSiteLinksThem() {
        XCTAssertEqual(Game.of(url("https://empanadas.io/spin")), .spin)
        XCTAssertEqual(Game.of(url("https://empanadas.io/spin.html")), .spin)
        XCTAssertEqual(Game.of(url("https://empanadas.io/flappy?au=1")), .flappy)
        XCTAssertEqual(Game.of(url("https://empanadas.io/tower/")), .tower)
        XCTAssertNil(Game.of(url("https://empanadas.io/spinner")))
        XCTAssertNil(Game.of(url("https://example.com/spin")))
        XCTAssertNil(Game.of(url("http://empanadas.io/spin")))
    }

    func testSitePagesTheAppShowsNatively() {
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/dashboard")), .home)
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/dashboard.php")), .home)
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/account")), .settings)
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/account/index.php")), .settings)
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/tower?au=1")), .game(.tower))
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/profile/abc")))
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/account_2fa")))
    }

    func testOnlyFlappyAndTowerDrawTheirOwnCloseButton() {
        XCTAssertFalse(Game.spin.hasOwnCloseButton)
        XCTAssertTrue(Game.flappy.hasOwnCloseButton)
        XCTAssertTrue(Game.tower.hasOwnCloseButton)
    }

    func testWhereAGameSendsThePlayerWhenTheyLeave() {
        // backToGames() in the site's _flappy.js and _tower.js.
        XCTAssertTrue(SiteURLs.isGameExitURL(url("https://empanadas.io/#games")))
        XCTAssertTrue(SiteURLs.isGameExitURL(url("https://empanadas.io/")))
        XCTAssertTrue(SiteURLs.isGameExitURL(url("https://empanadas.io")))
        XCTAssertTrue(SiteURLs.isGameExitURL(url("https://empanadas.io/index.php")))
        XCTAssertTrue(SiteURLs.isGameExitURL(url("https://empanadas.io/v2/dashboard")))
        XCTAssertFalse(SiteURLs.isGameExitURL(url("https://empanadas.io/flappy")), "the game itself")
        XCTAssertFalse(SiteURLs.isGameExitURL(url("https://empanadas.io/v2/login")))
        XCTAssertFalse(SiteURLs.isGameExitURL(url("https://example.com/")))
    }

    func testDeepLinks() {
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://home")), .home)
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://settings")), .settings)
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://play/flappy")), .game(.flappy))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://play/pacman")))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://play")))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://auth?t=x")), "sign-in links are not routes")
        XCTAssertNil(NativeRoute.of(deepLink: url("https://empanadas.io/play/flappy")))
    }

    func testSignInSignals() {
        func signal(_ string: String, _ status: Int = 200, mainFrame: Bool = true) -> SignInSignal? {
            SignInSignal.of(responseURL: url(string), statusCode: status, isMainFrame: mainFrame)
        }
        XCTAssertEqual(signal("https://empanadas.io/v2/dashboard"), .signedIn)
        XCTAssertNil(signal("https://empanadas.io/v2/dashboard", mainFrame: false), "an iframe says nothing")
        XCTAssertNil(signal("https://empanadas.io/v2/dashboard", 500))
        XCTAssertEqual(signal("https://empanadas.io/v2/auth/logout.php"), .signedOut)
        XCTAssertEqual(signal("https://empanadas.io/v2/auth/logout.php", 302, mainFrame: false), .signedOut)
        XCTAssertEqual(signal("https://empanadas.io/v2/login?redirect=v2%2Fdashboard"), .unsure)
        XCTAssertNil(signal("https://empanadas.io/spin"))
        XCTAssertNil(signal("https://example.com/v2/dashboard"))
    }
}

final class AccountAPITests: XCTestCase {
    private func cookie(_ properties: [HTTPCookiePropertyKey: Any]) -> HTTPCookie {
        var properties = properties
        properties[.path] = properties[.path] ?? "/"
        properties[.name] = properties[.name] ?? "PHPSESSID"
        properties[.value] = properties[.value] ?? "x"
        return HTTPCookie(properties: properties)!
    }

    func testCookiesGoOnlyWhereTheyBelong() {
        let site = URL(string: "https://empanadas.io/v2/account_edit.php")!
        XCTAssertTrue(AccountAPI.cookie(cookie([.domain: "empanadas.io"]), appliesTo: site))
        XCTAssertTrue(AccountAPI.cookie(cookie([.domain: ".empanadas.io"]), appliesTo: site))
        XCTAssertTrue(AccountAPI.cookie(cookie([.domain: ".empanadas.io"]),
                                        appliesTo: URL(string: "https://www.empanadas.io/")!))
        XCTAssertFalse(AccountAPI.cookie(cookie([.domain: "empanadas.io"]),
                                         appliesTo: URL(string: "https://www.empanadas.io/")!),
                       "a host-only cookie stays on its host")
        XCTAssertFalse(AccountAPI.cookie(cookie([.domain: "example.com"]), appliesTo: site))
        XCTAssertFalse(AccountAPI.cookie(cookie([.domain: "empanadas.io", .path: "/admin"]), appliesTo: site))
        XCTAssertFalse(AccountAPI.cookie(cookie([.domain: "empanadas.io", .expires: Date.distantPast]), appliesTo: site))
    }

    func testFormBodyEncodesEverythingButTheUnreservedCharacters() {
        let body = AccountAPI.formBody([("account_change", "delete_account"), ("cp", "DE LETE&é")])
        XCTAssertEqual(String(data: body, encoding: .utf8), "account_change=delete_account&cp=DE%20LETE%26%C3%A9")
    }

    private func snapshot(_ json: String) throws -> AccountSnapshot {
        try JSONDecoder().decode(AccountSnapshot.self, from: Data(json.utf8))
    }

    private let settingsJSON = """
        {"publicaccount":1,"starsign":1,"allownf":0,"analytics":1,"theme":2,
         "promoemails":0,"otheremails":1,"recapemails":1,"newsignins":1}
        """

    func testReadsTheIOSAccountAnswer() throws {
        // What /ios/account.php sends (tests/iosapp_test.php on the site).
        let snap = try snapshot("""
            {"ok":true,"api":1,"account":{"id":42,"username":"tester","email":"t@example.com",
             "email_verified":true,"pending_email":null,"pfp":"/Content/Images/ProfilePics/lg/abc.jpeg",
             "pfp_small":"/Content/Images/ProfilePics/sm/abc.jpeg","has_custom_pfp":true,
             "created_at":"2024-01-02 03:04:05","birthday":"2000-01-02","star_sign":"Capricorn",
             "connections":["discord","google"],"two_factor":true,"passkeys":2},
             "has_birthday":true,"settings":\(settingsJSON),"csrf":"tok"}
            """)
        XCTAssertEqual(snap.username, "tester")
        XCTAssertEqual(snap.email, "t@example.com")
        XCTAssertEqual(snap.account.id, 42)
        XCTAssertEqual(snap.account.connections, ["discord", "google"])
        XCTAssertTrue(snap.account.twoFactor)
        XCTAssertEqual(snap.account.passkeys, 2)
        XCTAssertNil(snap.account.pendingEmail)
        XCTAssertEqual(snap.pictureURL?.absoluteString, "https://empanadas.io/Content/Images/ProfilePics/lg/abc.jpeg")
        XCTAssertTrue(snap.hasBirthday)
        XCTAssertEqual(snap.settings.theme, 2)
        XCTAssertEqual(snap.settings.allownf, 0)
        XCTAssertEqual(snap.csrf, "tok")
    }

    func testAnAccountWithFieldsMissingStillLoads() throws {
        let snap = try snapshot("""
            {"ok":true,"account":{"username":"tester"},"settings":\(settingsJSON),"csrf":"tok"}
            """)
        XCTAssertEqual(snap.username, "tester")
        XCTAssertEqual(snap.email, "")
        XCTAssertNil(snap.pictureURL)
        XCTAssertFalse(snap.account.twoFactor)
        XCTAssertEqual(snap.account.connections, [])
    }

    func testReadsTheOlderGetDataAnswer() throws {
        let snap = try snapshot("""
            {"result":1,"username":"tester","email":"t@example.com","pfp":"https://cdn.example/x.png",
             "has_birthday":false,"settings":\(settingsJSON),"csrf":"tok"}
            """)
        XCTAssertEqual(snap.username, "tester")
        XCTAssertEqual(snap.pictureURL?.absoluteString, "https://cdn.example/x.png")
        XCTAssertFalse(snap.hasBirthday)
    }

    func testIOSRepliesAndEverythingElse() {
        XCTAssertEqual(AccountAPI.iosReply(Data(#"{"ok":false,"api":1,"reason":"no_session"}"#.utf8))?.reason, "no_session")
        XCTAssertEqual(AccountAPI.iosReply(Data(#"{"ok":true,"api":1}"#.utf8))?.ok, true)
        XCTAssertNil(AccountAPI.iosReply(Data("<html>404</html>".utf8)), "nginx's error page")
        XCTAssertNil(AccountAPI.iosReply(Data("no_type".utf8)))
        XCTAssertNil(AccountAPI.iosReply(Data(#"{"result":0}"#.utf8)), "not an /ios/ answer")
    }

    func testLoadErrorsSayWhatWentWrong() {
        XCTAssertEqual(AccountError.unavailable("server_error").errorDescription,
                       "Your account couldn't be loaded (server_error).")
        XCTAssertEqual(AccountError.unavailable("").errorDescription, "Your account couldn't be loaded.")
    }

    func testSiteReasonsBecomePlainText() {
        XCTAssertEqual(AccountAPI.stripTags("Your request has expired or was invalid.<br>Try <b>reloading</b> the page!"),
                       "Your request has expired or was invalid.\nTry reloading the page!")
    }
}
