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

    func testSiteReasonsBecomePlainText() {
        XCTAssertEqual(AccountAPI.stripTags("Your request has expired or was invalid.<br>Try <b>reloading</b> the page!"),
                       "Your request has expired or was invalid.\nTry reloading the page!")
    }
}
