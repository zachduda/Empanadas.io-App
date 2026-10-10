import UIKit
import WebKit

/// Answers window.empanadasApp (Resources/bridge.js). The iOS counterpart of
/// the desktop app's preload.js.
///
/// Every message is checked: it must come from the main frame of the page this
/// bridge belongs to, and that frame must be on empanadas.io. A popup inherits
/// its opener's configuration - this handler included - so the web view check
/// is what keeps a provider's sign-in page from reaching it.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "empanadas"

    weak var page: WebPage?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let page, let app = page.app,
              message.webView === page.webView,
              message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == "https",
              SiteURLs.isAppHost(message.frameInfo.securityOrigin.host) else {
            return (nil, "Not allowed")
        }
        guard let body = message.body as? [String: Any], let command = body["cmd"] as? String else {
            return (nil, "Bad message")
        }
        let args = body["args"] as? [String: Any] ?? [:]

        switch command {
        case "haptic":
            Haptics.play(args["style"] as? String ?? "light")
            return (true, nil)

        case "openSettings":
            app.navigate(to: .settings)
            return (true, nil)

        case "openGame":
            guard let name = args["game"] as? String, let game = Game(rawValue: name) else {
                return (false, nil)
            }
            app.navigate(to: .game(game))
            return (true, nil)

        case "closeGame":
            // Only from the game player, so a page elsewhere cannot use it to
            // close a game it is not part of.
            guard case .game? = page.ownRoute else { return (false, nil) }
            app.closeGame()
            return (true, nil)

        case "share":
            // Only the site's own pages: this is not a way to put arbitrary
            // links in front of the player with the app's name on them.
            guard let string = args["url"] as? String, let url = URL(string: string), SiteURLs.isAppURL(url) else {
                return (false, nil)
            }
            app.share(url)
            return (true, nil)

        case "ping":
            let result = await app.account.ping()
            return (["ok": result.ok, "status": result.status, "pong": result.pong], nil)

        case "clearCache":
            await WebEnvironment.clearCache()
            return (["ok": true], nil)

        case "pageColor":
            // Only ever a colour to paint around the page; anything that does
            // not parse as an opaque one is ignored.
            guard let text = args["color"] as? String, let color = CSSColor(text), !color.isTransparent else {
                return (false, nil)
            }
            page.setPageColor(UIColor(red: color.red, green: color.green, blue: color.blue, alpha: 1))
            return (true, nil)

        default:
            return (nil, "Unknown command")
        }
    }
}

enum Haptics {
    static var isEnabled: Bool {
        UserDefaults.standard.object(forKey: Preferences.hapticsKey) as? Bool ?? true
    }

    @MainActor
    static func play(_ style: String) {
        guard isEnabled else { return }
        switch style {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "selection": UISelectionFeedbackGenerator().selectionChanged()
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}

enum Preferences {
    static let hapticsKey = "haptics"
    static let signedInKey = "signedIn"
    static let themeKey = "theme"
}
