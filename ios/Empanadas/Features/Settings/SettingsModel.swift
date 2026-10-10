import Foundation

/// State behind the native Settings screen: the account's settings as the site
/// has them, and one change at a time going back to it. A control only ever
/// shows a value the site accepted - a failed change is put back.
@MainActor
@Observable
final class SettingsModel {
    private(set) var snapshot: AccountSnapshot?
    private(set) var isLoading = false
    private(set) var loadError: AccountError?
    /// The field being saved. Every control waits while one is: the site takes
    /// one change at a time (update_account() refuses while `active`).
    private(set) var savingField: String?
    var saveError: String?
    var needsCaptcha = false

    func load(app: AppModel) async {
        isLoading = true
        defer { isLoading = false }
        do {
            snapshot = try await app.account.snapshot()
            loadError = nil
            app.theme = snapshot?.settings.theme ?? app.theme
        } catch let error as AccountError {
            if error == .signedOut { app.observe(.unsure) }
            loadError = error
        } catch {
            loadError = .network
        }
    }

    func value(_ keyPath: KeyPath<AccountSettings, Int>) -> Int {
        snapshot?.settings[keyPath: keyPath] ?? 0
    }

    func set(_ keyPath: WritableKeyPath<AccountSettings, Int>, field: String, to value: Int, app: AppModel) async {
        guard let current = snapshot?.settings[keyPath: keyPath], current != value, savingField == nil else { return }
        snapshot?.settings[keyPath: keyPath] = value
        savingField = field
        defer { savingField = nil }

        do {
            try await withFreshToken(app) { csrf in
                try await app.account.update(field, to: value, csrf: csrf)
            }
            if field == "theme" { app.theme = value }
        } catch {
            snapshot?.settings[keyPath: keyPath] = current
            report(error, app: app)
        }
    }

    /// Returns true when the account is gone.
    func deleteAccount(confirmation: String, app: AppModel) async -> Bool {
        guard savingField == nil else { return false }
        savingField = "delete_account"
        defer { savingField = nil }
        do {
            try await withFreshToken(app) { csrf in
                try await app.account.deleteAccount(confirmation: confirmation, csrf: csrf)
            }
            return true
        } catch {
            report(error, app: app)
            return false
        }
    }

    /// The site clears its CSRF token after a mismatch (checkCsrf() in
    /// account_edit.php), for instance when the web account page was opened
    /// in the meantime and issued a new one. Fetch the current one and try
    /// once more.
    ///
    /// With no snapshot (it failed to load earlier), one is fetched first, so
    /// deleting the account never depends on the Settings screen having
    /// loaded.
    private func withFreshToken(_ app: AppModel, _ body: (String) async throws -> Void) async throws {
        if snapshot == nil {
            snapshot = try await app.account.snapshot()
            loadError = nil
        }
        guard let csrf = snapshot?.csrf else { throw AccountError.unavailable("") }
        do {
            try await body(csrf)
        } catch AccountError.staleToken {
            let fresh = try await app.account.snapshot()
            snapshot?.csrf = fresh.csrf
            try await body(fresh.csrf)
        }
    }

    private func report(_ error: Error, app: AppModel) {
        switch error as? AccountError {
        case .signedOut?:
            app.observe(.unsure)
        case .needsCaptcha?:
            needsCaptcha = true
        case let error?:
            saveError = error.localizedDescription
        case nil:
            saveError = AccountError.network.localizedDescription
        }
    }
}
