import CryptoKit
import Foundation

/// Which way the welcome screen's question was answered: "Yup!" opens the
/// site's username step, "Nope." its Pick a Username.
enum SignInMode: String {
    case login
    case create
}

/// One sign-in, run start to finish in the system browser.
///
/// The app never shows the login page: it opens /v2/auth/app.php in an
/// ASWebAuthenticationSession, where Safari's AutoFill and the player's
/// passkeys work, and the site hands the finished sign-in back with an
/// empanadas-io://signin?code= link. The code is redeemed from the app's own
/// session (AccountAPI.redeemSignIn) with this request's PKCE verifier
/// (RFC 7636), which never leaves the app: a code that went astray, or one
/// from somebody else's sign-in, is no use without it.
///
/// The site's half is described above APP_SIGNIN_TTL in its v2/_lib.php.
struct SignInRequest {
    let mode: SignInMode
    /// 32 random bytes, base64url: 43 characters.
    let verifier: String
    /// base64url(SHA-256(verifier)): what the site is told.
    let challenge: String
    let startedAt: Date

    init(mode: SignInMode, verifier: String = SignInRequest.makeVerifier(), startedAt: Date = Date()) {
        self.mode = mode
        self.verifier = verifier
        challenge = Self.challenge(for: verifier)
        self.startedAt = startedAt
    }

    /// Where the browser starts.
    var url: URL { SiteURLs.appSignIn(challenge: challenge, mode: mode) }

    /// Still worth finishing: the site keeps a sign-in for the app this long
    /// (APP_SIGNIN_TTL).
    func isFresh(at now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(startedAt)
        return age >= 0 && age < AppConfig.signInTTL
    }

    static func makeVerifier() -> String {
        // Cryptographically secure on Apple platforms.
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return base64URL(Data(bytes))
    }

    /// The S256 challenge for a verifier.
    static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// Base64 with the URL-safe alphabet and no padding (RFC 7636, appendix A).
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
