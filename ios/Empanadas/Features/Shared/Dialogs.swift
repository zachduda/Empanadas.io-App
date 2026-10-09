import UIKit

/// alert(), confirm() and prompt() for the web views. Without these WebKit
/// answers every confirm() with false - and the account page asks one before
/// disconnecting a provider.
@MainActor
enum Dialogs {
    static func alert(_ message: String) async {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume() })
            guard present(alert) else { return continuation.resume() }
        }
    }

    static func confirm(_ message: String) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            guard present(alert) else { return continuation.resume(returning: false) }
        }
    }

    static func prompt(_ message: String, defaultText: String?) async -> String? {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                continuation.resume(returning: alert?.textFields?.first?.text ?? "")
            })
            guard present(alert) else { return continuation.resume(returning: nil) }
        }
    }

    /// Presents over whatever is frontmost. False when nothing can present.
    @discardableResult
    static func present(_ controller: UIViewController) -> Bool {
        guard var top = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController else { return false }
        while let presented = top.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        top.present(controller, animated: true)
        return true
    }
}
