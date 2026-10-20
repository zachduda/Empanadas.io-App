import Foundation

/// State behind the native Settings screen: the account's settings as the site
/// has them, and one change at a time going back to it. A control only ever
/// shows a value the site accepted - a failed change is put back.
///
/// Opens with the copy AccountAPI saved last time (OfflineStore), so the
/// screen has the account on it at once and offline. That copy has no csrf
/// token; withFreshToken fetches one before anything is changed.
@MainActor
@Observable
final class SettingsModel {
    private(set) var snapshot: AccountSnapshot?
    /// When `snapshot` came from the site.
    private(set) var updatedAt: Date?
    private(set) var isLoading = false
    private(set) var loadError: AccountError?
    /// The field being saved. Every control waits while one is: the site takes
    /// one change at a time (update_account() refuses while `active`).
    private(set) var savingField: String?
    var saveError: String?
    var needsCaptcha = false
    /// Bumped by reset(), as DashboardModel's: an answer asked for before a
    /// sign-out is the last account's, and is dropped.
    @ObservationIgnored private var generation = 0

    init() {
        if let saved = OfflineStore.load(AccountSnapshot.self, .settings) {
            snapshot = saved.value
            updatedAt = saved.savedAt
        }
    }

    /// Asks the site, unless this session's last answer is younger than
    /// `maxAge` seconds (coming back to the tab should not ask every time).
    /// The copy saved last time never counts: it has no token to change
    /// anything with.
    func load(app: AppModel, maxAge: TimeInterval = 0) async {
        if loadError == nil, snapshot?.csrf.isEmpty == false, let updatedAt,
           Date().timeIntervalSince(updatedAt) < maxAge { return }
        let generation = self.generation
        isLoading = true
        defer {
            if generation == self.generation { isLoading = false }
        }
        do {
            let fresh = try await app.account.snapshot()
            // Signed out meanwhile: the theme is not the next account's.
            guard generation == self.generation, app.session == .signedIn else { return }
            snapshot = fresh
            updatedAt = Date()
            loadError = nil
            app.theme = fresh.settings.theme
        } catch let error as AccountError {
            // Cancelled (the tab left before the answer): not a failure.
            guard generation == self.generation, !Task.isCancelled else { return }
            if error == .signedOut { app.observe(.unsure) }
            loadError = error
        } catch {
            guard generation == self.generation, !Task.isCancelled else { return }
            loadError = .network
        }
    }

    /// Signed out: nothing of the last account may show for the next.
    func reset() {
        generation += 1
        snapshot = nil
        updatedAt = nil
        isLoading = false
        loadError = nil
        savingField = nil
        saveError = nil
        needsCaptcha = false
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
        // None yet, or only the saved copy, whose token was left blank.
        if snapshot == nil || snapshot?.csrf.isEmpty == true {
            let fresh = try await app.account.snapshot()
            if snapshot == nil {
                snapshot = fresh
            } else {
                snapshot?.csrf = fresh.csrf
            }
            loadError = nil
        }
        guard let csrf = snapshot?.csrf, !csrf.isEmpty else { throw AccountError.unavailable("") }
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
