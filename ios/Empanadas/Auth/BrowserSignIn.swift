import AuthenticationServices
import UIKit

/// "Log in with Google/GitHub/Discord" in the system browser. The site's half
/// is described above appAuthIssue() in its v2/_lib.php: the app opens
/// /v2/auth/browser.php?t=<ticket>, the browser signs in with the provider
/// (where the player is usually signed in already), and the site finishes on
/// empanadas-io://auth?service=&t=&c=, which this session hands back.
///
/// Google refuses OAuth inside a WKWebView, so this is not optional.
@MainActor
final class BrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var startedAt: Date?

    /// The page the finished sign-in should load in.
    weak var origin: WebPage?

    /// Is a returning empanadas-io://auth link one the app asked for? A link
    /// can also arrive through onOpenURL (the browser opened the app itself),
    /// so this is checked there too.
    var isExpecting: Bool {
        guard let startedAt else { return false }
        return Date().timeIntervalSince(startedAt) < AppConfig.browserSignInTTL
    }

    func start(_ url: URL, completion: @escaping @MainActor (URL) -> Void) {
        session?.cancel()
        startedAt = Date()

        let handler: ASWebAuthenticationSession.CompletionHandler = { [weak self] callbackURL, _ in
            Task { @MainActor in
                self?.session = nil
                // A cancel leaves startedAt alone: the player may still
                // finish in Safari, which opens the app with the link.
                if let callbackURL { completion(callbackURL) }
            }
        }

        let session: ASWebAuthenticationSession
        if #available(iOS 17.4, *) {
            session = ASWebAuthenticationSession(url: url, callback: .customScheme(AppConfig.urlScheme),
                                                 completionHandler: handler)
        } else {
            session = ASWebAuthenticationSession(url: url, callbackURLScheme: AppConfig.urlScheme,
                                                 completionHandler: handler)
        }
        session.presentationContextProvider = self
        // Share Safari's cookies, so a player already signed in to the
        // provider there is not asked again.
        session.prefersEphemeralWebBrowserSession = false
        self.session = session

        if !session.start() {
            self.session = nil
            startedAt = nil
        }
    }

    func finish() {
        startedAt = nil
        session = nil
        origin = nil
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}
