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
    /// Bumped by every request and by reset(): only the answer to the newest
    /// request is shown, and none asked for before a sign-out (the last
    /// account's).
    @ObservationIgnored private var generation = 0

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
        await fetch(app: app)
    }

    /// After a change on the site (a friend added, a round saved): asks
    /// again even while a request is under way. That one was sent before the
    /// change, and its answer is dropped; skipped, as load() would, the
    /// dashboard showed the state from before the change.
    func reload(app: AppModel) async {
        await fetch(app: app)
    }

    private func fetch(app: AppModel) async {
        generation += 1
        let generation = self.generation
        isLoading = true
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            let fresh = try await app.account.dashboard()
            guard generation == self.generation else { return }
            data = fresh
            updatedAt = Date()
            error = nil
            app.gameCenter.report(fresh)
            app.dashboardUpdated()
        } catch let failure as AccountError {
            // Cancelled (the screen left, or the app went to the back): not
            // a failure, and not one to show until the next refresh.
            guard generation == self.generation, !Task.isCancelled else { return }
            if failure == .signedOut { app.observe(.unsure) }
            error = failure
        } catch {
            guard generation == self.generation, !Task.isCancelled else { return }
            self.error = .network
        }
    }

    /// Signed out: nothing of the last account may show for the next.
    func reset() {
        generation += 1
        isLoading = false
        data = nil
        updatedAt = nil
        error = nil
    }
}
