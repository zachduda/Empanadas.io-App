import AuthenticationServices
import UIKit

/// A page of the site in the system browser (an ASWebAuthenticationSession)
/// that ends by going to an empanadas-io:// link, which comes straight back
/// here rather than through the system.
///
/// It shares Safari's cookies, so a player already signed in to Google, GitHub
/// or Discord there (or to Empanadas.io) is not asked again, and Safari's
/// AutoFill and the passkeys in their iCloud Keychain work as they do on the
/// website. None of that reaches a WKWebView of the app's.
@MainActor
final class BrowserSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    /// Which open() the current session belongs to.
    private var current: UUID?

    /// Opens `url`. `completion` gets the empanadas-io:// link the page ended
    /// on, or nil when the player closed it first. False, and no completion,
    /// when it could not be shown at all. Opening another page closes this
    /// one without a completion.
    @discardableResult
    func open(_ url: URL, completion: @escaping @MainActor @Sendable (URL?) -> Void) -> Bool {
        let id = UUID()
        current = id
        // Its handler runs later, and finds it is no longer current.
        session?.cancel()

        // Sendable, so not taken to be on the main actor, whichever thread
        // the session calls it on: it goes to the main actor itself.
        let handler: ASWebAuthenticationSession.CompletionHandler = { @Sendable [weak self] callbackURL, _ in
            Task { @MainActor in
                guard let self, self.current == id else { return }
                self.session = nil
                self.current = nil
                completion(callbackURL)
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
        // Share Safari's cookies (see above).
        session.prefersEphemeralWebBrowserSession = false
        self.session = session

        guard session.start() else {
            self.session = nil
            current = nil
            return false
        }
        return true
    }

    /// Closes the page, if it is open, without a completion: what it was for
    /// finished some other way.
    func cancel() {
        current = nil
        session?.cancel()
        session = nil
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

/// "Connect" Google/GitHub/Discord on the account page, in the system
/// browser. The site's half is described above appAuthIssue() in its
/// v2/_lib.php: the page sends the app to /v2/auth/browser.php?t=<ticket>, the
/// browser signs in with the provider (where the player is usually signed in
/// already), and the site finishes on empanadas-io://auth?service=&t=&c=,
/// which the page that started it loads to link the account.
///
/// Google refuses OAuth inside a WKWebView, so this is not optional. Signing
/// in to the app itself is AppModel.signIn, which runs all of it in the
/// browser.
@MainActor
final class BrowserSignIn {
    private let browser = BrowserSession()
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

    func start(_ url: URL, completion: @escaping @MainActor @Sendable (URL) -> Void) {
        startedAt = Date()
        let opened = browser.open(url) { callbackURL in
            // A cancel leaves startedAt alone: the player may still finish in
            // Safari, which opens the app with the link.
            if let callbackURL { completion(callbackURL) }
        }
        if !opened { startedAt = nil }
    }

    func finish() {
        startedAt = nil
        origin = nil
    }
}
