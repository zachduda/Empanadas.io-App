import XCTest
@testable import Empanadas

/// Port of the desktop app's test/urls.test.js: the same rules, the same
/// cases. A failure here is a hole in the navigation filter or a sign-in flow
/// that silently stops working.
final class SiteURLsTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }

    // Shaped like the site's appAuthToken(): letters and digits, 32 to 128 long.
    private let ticket = String(repeating: "aB3", count: 20) + "xyz1"
    private let code = String(repeating: "9Zq", count: 20) + "Q7r2"

    func testRecognisesTheSiteAndItsSubdomains() {
        XCTAssertTrue(SiteURLs.isAppURL(url("https://empanadas.io/")))
        XCTAssertTrue(SiteURLs.isAppURL(url("https://www.empanadas.io/play")))
        XCTAssertTrue(SiteURLs.isAppURL(url("https://EMPANADAS.IO/")), "hosts are case-insensitive")
    }

    func testRejectsLookalikesAndDowngrades() {
        XCTAssertFalse(SiteURLs.isAppURL(url("https://empanadas.io.example.com/")), "a suffixed lookalike")
        XCTAssertFalse(SiteURLs.isAppURL(url("https://empanadas.io@example.com/")), "a userinfo trick")
        XCTAssertFalse(SiteURLs.isAppURL(url("https://notempanadas.io/")), "an unrelated host")
        XCTAssertFalse(SiteURLs.isAppURL(url("http://empanadas.io/")), "plain http")
        if let notAURL = URL(string: "not a url") {
            XCTAssertFalse(SiteURLs.isAppURL(notAURL), "an unparseable string")
        }
    }

    func testRecognisesTheSignInProviders() {
        XCTAssertTrue(SiteURLs.isAuthURL(url("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")))
        XCTAssertTrue(SiteURLs.isAuthURL(url("https://github.com/login/oauth/authorize?client_id=x")))
        XCTAssertTrue(SiteURLs.isAuthURL(url("https://discord.com/oauth2/authorize?client_id=x")))
    }

    func testDoesNotTreatTheWholeProviderDomainAsASignInHost() {
        XCTAssertFalse(SiteURLs.isAuthURL(url("https://drive.google.com/")))
        XCTAssertFalse(SiteURLs.isAuthURL(url("https://gist.github.com/")))
        XCTAssertFalse(SiteURLs.isAuthURL(url("https://accounts.google.com.evil.test/")))
        XCTAssertFalse(SiteURLs.isAuthURL(url("http://accounts.google.com/")))
    }

    func testTheSiteIsNotAnAuthHostAndViceVersa() {
        XCTAssertFalse(SiteURLs.isAuthURL(url("https://empanadas.io/")))
        XCTAssertFalse(SiteURLs.isAppURL(url("https://accounts.google.com/")))
    }

    func testThePopupMayFollowThePostSignInRoundabout() {
        XCTAssertTrue(SiteURLs.isSSOURL(url("https://zachduda.com/v2/roundabout")))
        XCTAssertTrue(SiteURLs.isSSOURL(url("https://www.he1ium.com/")))
        XCTAssertTrue(SiteURLs.isPopupURL(url("https://zachduda.com/v2/roundabout")))
        XCTAssertTrue(SiteURLs.isPopupURL(url("https://empanadas.io/v2/auth/flow.php?service=github")))
        XCTAssertTrue(SiteURLs.isPopupURL(url("https://github.com/login/oauth/authorize")))
        XCTAssertFalse(SiteURLs.isSSOURL(url("https://zachduda.com.evil.test/")))
        XCTAssertFalse(SiteURLs.isSSOURL(url("http://zachduda.com/")))
        XCTAssertFalse(SiteURLs.isPopupURL(url("https://example.com/")))
        XCTAssertFalse(SiteURLs.isAppURL(url("https://zachduda.com/")))
    }

    func testAPopupHandsOrdinaryPagesBack() {
        XCTAssertTrue(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/account?linked=github")))
        XCTAssertTrue(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/account/")))
        XCTAssertTrue(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/dashboard")))
        XCTAssertTrue(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/login?error=oauth_err")))
    }

    func testAPopupKeepsThePagesThatAreStillMidSignIn() {
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/auth/flow.php?code=x")))
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/auth/js.php?r=v2/dashboard")))
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/auth/2fa.php")))
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://empanadas.io/authcancel.html")))
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/account_edit.php?403=1")))
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://empanadas.io/v2/accounts")))
        XCTAssertFalse(SiteURLs.isHandoffURL(url("https://github.com/v2/account")))
    }

    func testTheSiteCanSendASignInOutToTheBrowser() {
        XCTAssertTrue(SiteURLs.isBrowserSignInURL(url("https://empanadas.io/v2/auth/browser.php?t=\(ticket)")))
        XCTAssertTrue(SiteURLs.isBrowserSignInURL(url("https://empanadas.io/v2/auth/browser?t=\(ticket)")))
    }

    func testOnlyThatPageWithATicketGoesOutToTheBrowser() {
        XCTAssertFalse(SiteURLs.isBrowserSignInURL(url("https://empanadas.io/v2/auth/browser.php?done=1")))
        XCTAssertFalse(SiteURLs.isBrowserSignInURL(url("https://empanadas.io/v2/auth/browser.php")))
        XCTAssertFalse(SiteURLs.isBrowserSignInURL(url("https://empanadas.io/v2/auth/browser.php?t=short")))
        XCTAssertFalse(SiteURLs.isBrowserSignInURL(url("https://empanadas.io/v2/auth/flow.php?service=google&app_ticket=\(ticket)")))
        XCTAssertFalse(SiteURLs.isBrowserSignInURL(url("http://empanadas.io/v2/auth/browser.php?t=\(ticket)")))
        XCTAssertFalse(SiteURLs.isBrowserSignInURL(url("https://empanadas.io.evil.test/v2/auth/browser.php?t=\(ticket)")))
    }

    func testASignInComingBackFromTheBrowserFinishesOnTheSite() throws {
        let link = url("empanadas-io://auth?service=google&t=\(ticket)&c=\(code)")
        XCTAssertTrue(SiteURLs.isAuthDeepLink(link))

        let redeem = try XCTUnwrap(SiteURLs.authRedeemURL(link))
        XCTAssertEqual(redeem.scheme, "https")
        XCTAssertEqual(redeem.host(), "empanadas.io")
        XCTAssertEqual(redeem.path(), "/v2/auth/flow.php")
        XCTAssertEqual(SiteURLs.queryValue("service", in: redeem), "google")
        XCTAssertEqual(SiteURLs.queryValue("app_ticket", in: redeem), ticket)
        XCTAssertEqual(SiteURLs.queryValue("app_code", in: redeem), code)

        XCTAssertNotNil(SiteURLs.authRedeemURL(url("empanadas-io://auth/?service=github&t=\(ticket)&c=\(code)")),
                        "with a trailing slash")
    }

    func testAMalformedSignInLinkIsRefused() {
        func redeem(_ query: String) -> URL? { SiteURLs.authRedeemURL(url("empanadas-io://auth?" + query)) }
        XCTAssertNil(redeem("service=google&t=\(ticket)"), "no code")
        XCTAssertNil(redeem("service=google&c=\(code)"), "no ticket")
        XCTAssertNil(redeem("t=\(ticket)&c=\(code)"), "no provider")
        XCTAssertNil(redeem("service=Google!&t=\(ticket)&c=\(code)"), "a strange provider")
        XCTAssertNil(redeem("service=google&t=\(ticket)%26x%3D1&c=\(code)"), "a ticket carrying more query")
        XCTAssertNil(redeem("service=google&t=abc&c=\(code)"), "a short ticket")
        XCTAssertNil(SiteURLs.authRedeemURL(url("empanadas-io://auth/elsewhere?service=google&t=\(ticket)&c=\(code)")), "a path")
        XCTAssertNil(SiteURLs.authRedeemURL(url("empanadas-io://play?service=google&t=\(ticket)&c=\(code)")), "another kind of link")
        XCTAssertFalse(SiteURLs.isAuthDeepLink(url("empanadas-io://play")))
        XCTAssertNil(SiteURLs.authRedeemURL(url("https://auth/?service=google&t=\(ticket)&c=\(code)")), "another scheme")
    }
}
