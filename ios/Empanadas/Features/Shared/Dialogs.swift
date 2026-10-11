import UIKit

/// alert(), confirm() and prompt() for the web views. Without these WebKit
/// answers every confirm() with false - and the account page asks one before
/// disconnecting a provider.
@MainActor
enum Dialogs {
    static func alert(_ message: String) async {
        await withCheckedContinuation { continuation in
            let answer = Answer(continuation, otherwise: ())
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in answer.give(()) })
            if !present(alert) { answer.give(()) }
        }
    }

    static func confirm(_ message: String) async -> Bool {
        await withCheckedContinuation { continuation in
            let answer = Answer(continuation, otherwise: false)
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer.give(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in answer.give(true) })
            if !present(alert) { answer.give(false) }
        }
    }

    static func prompt(_ message: String, defaultText: String?) async -> String? {
        await withCheckedContinuation { continuation in
            let answer = Answer<String?>(continuation, otherwise: nil)
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer.give(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                answer.give(alert?.textFields?.first?.text ?? "")
            })
            if !present(alert) { answer.give(nil) }
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

/// Hands a dialog's answer back to the page exactly once. A button gives its
/// own. An alert that goes without one (taken down with the sheet it was
/// shown over, at a sign-out, or never shown at all) gives `otherwise`, as
/// Cancel would, when it is released and this with it: before, the page that
/// asked waited on it for good.
private final class Answer<Value> {
    private var continuation: CheckedContinuation<Value, Never>?
    private let otherwise: Value

    init(_ continuation: CheckedContinuation<Value, Never>, otherwise: Value) {
        self.continuation = continuation
        self.otherwise = otherwise
    }

    func give(_ value: Value) {
        continuation?.resume(returning: value)
        continuation = nil
    }

    deinit {
        continuation?.resume(returning: otherwise)
    }
}
