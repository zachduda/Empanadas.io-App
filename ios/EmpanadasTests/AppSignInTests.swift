import XCTest
@testable import Empanadas

/// The PKCE pair a sign-in in the browser is made with (SignInRequest). The
/// site checks it with appSigninVerifies() in its v2/_lib.php, and
/// tests/iosapp_test.php there runs the same RFC example: if the two sides
/// disagree, every sign-in comes back "expired".
final class AppSignInTests: XCTestCase {
    func testTheChallengeIsTheRFCsS256() {
        // RFC 7636, appendix B.
        XCTAssertEqual(SignInRequest.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testBase64URLHasNoPaddingAndTheURLSafeAlphabet() {
        XCTAssertEqual(SignInRequest.base64URL(Data([0xFB, 0xFF])), "-_8", "standard base64 is +/8=")
        XCTAssertEqual(SignInRequest.base64URL(Data()), "")
    }

    func testAVerifierIs43URLSafeCharactersAndNeverTheSameTwice() {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let verifiers = (0..<20).map { _ in SignInRequest.makeVerifier() }
        for verifier in verifiers {
            XCTAssertEqual(verifier.count, 43, "the shortest RFC 7636 allows, from 32 random bytes")
            XCTAssertTrue(verifier.unicodeScalars.allSatisfy { allowed.contains($0) }, verifier)
        }
        XCTAssertEqual(Set(verifiers).count, verifiers.count)
    }

    func testARequestSendsTheChallengeOfTheVerifierItKeeps() throws {
        let request = SignInRequest(mode: .create)
        XCTAssertEqual(request.challenge, SignInRequest.challenge(for: request.verifier))
        XCTAssertNotEqual(request.challenge, request.verifier)
        XCTAssertEqual(request.challenge.count, 43)

        let url = request.url
        XCTAssertEqual(url.host(), "empanadas.io")
        XCTAssertEqual(url.path(), "/v2/auth/app.php")
        XCTAssertEqual(SiteURLs.queryValue("challenge", in: url), request.challenge)
        XCTAssertEqual(SiteURLs.queryValue("mode", in: url), "create")
        XCTAssertNil(SiteURLs.queryValue("verifier", in: url), "the verifier never leaves the app")
        XCTAssertFalse(url.absoluteString.contains(request.verifier))
    }

    func testARequestIsWorthFinishingForAsLongAsTheSiteWaits() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let request = SignInRequest(mode: .login, startedAt: start)
        XCTAssertTrue(request.isFresh(at: start))
        XCTAssertTrue(request.isFresh(at: start.addingTimeInterval(AppConfig.signInTTL - 1)))
        XCTAssertFalse(request.isFresh(at: start.addingTimeInterval(AppConfig.signInTTL)), "APP_SIGNIN_TTL on the site")
        XCTAssertFalse(request.isFresh(at: start.addingTimeInterval(-60)), "a clock that went back")
    }

    /// The cookies a sign-in deletes first (AccountAPI.forgetSession): the
    /// last account's session, not Cloudflare's or another site's.
    func testASignInForgetsTheSitesCookiesButNotCloudflaresOrOtherSites() {
        func cookie(_ name: String, _ domain: String) -> HTTPCookie {
            HTTPCookie(properties: [.name: name, .value: "x", .domain: domain, .path: "/v2"])!
        }
        XCTAssertTrue(AccountAPI.isAccountCookie(cookie("PHPSESSID", "empanadas.io")))
        XCTAssertTrue(AccountAPI.isAccountCookie(cookie("PHPSESSID", ".empanadas.io")))
        XCTAssertTrue(AccountAPI.isAccountCookie(cookie("UAK", "www.empanadas.io")))
        XCTAssertFalse(AccountAPI.isAccountCookie(cookie("__cf_bm", ".empanadas.io")))
        XCTAssertFalse(AccountAPI.isAccountCookie(cookie("cf_clearance", ".empanadas.io")))
        XCTAssertFalse(AccountAPI.isAccountCookie(cookie("PHPSESSID", "notempanadas.io")))
        XCTAssertFalse(AccountAPI.isAccountCookie(cookie("SID", ".google.com")))
    }
}
