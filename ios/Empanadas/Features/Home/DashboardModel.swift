import Foundation

/// State behind the native dashboard. Opens with the last answer saved on
/// disk (OfflineStore), so the screen is never empty at launch or offline,
/// and replaces it whenever the site answers.
@MainActor
@Observable
final class DashboardModel {
    private(set) var data: Dashboard?
    /// When `data` came from the site.
    private(set) var updatedAt: Date?
    private(set) var isLoading = false
    /// Why the last refresh failed; nil once one succeeds.
    private(set) var error: AccountError?

    init() {
        restore()
    }

    private func restore() {
        guard let saved = OfflineStore.load(Dashboard.self, .dashboard) else { return }
        data = saved.value
        updatedAt = saved.savedAt
    }

    /// Asks the site, unless the last good answer is younger than `maxAge`
    /// seconds (switching back to the tab should not refetch every time).
    func load(app: AppModel, maxAge: TimeInterval = 0) async {
        if error == nil, let updatedAt, Date().timeIntervalSince(updatedAt) < maxAge { return }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            data = try await app.account.dashboard()
            updatedAt = Date()
            error = nil
        } catch let failure as AccountError {
            if failure == .signedOut { app.observe(.unsure) }
            error = failure
        } catch {
            self.error = .network
        }
    }

    /// Signed out: nothing of the last account may show for the next.
    func reset() {
        data = nil
        updatedAt = nil
        error = nil
    }
}
