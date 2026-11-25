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
    /// How many answers in a row were the same as the one before: what the
    /// pace of the refresh goes by (DashboardPace).
    @ObservationIgnored private var unchanged = 0
    /// The account just signed in to (AppModel.finishSignIn), until a
    /// dashboard for it has come back. The first requests of a new session
    /// can still go out with the last account's cookies (a web view of the
    /// last session's answering after they were deleted), and the site then
    /// answers for that account: shown, it stayed on Home until the player
    /// pulled down.
    @ObservationIgnored private var expectedUsername: String?

    /// How many times a dashboard for some other account is asked for again,
    /// a second more apart each time, before it is given up as an error.
    static let mismatchRetries = 3

    /// How long Home waits before asking again while it is showing.
    var pollInterval: TimeInterval {
        DashboardPace.interval(unchanged: unchanged)
    }

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
    ///
    /// Also when the player pulls down: something is expected to change, so
    /// the refresh goes back to once a minute.
    func reload(app: AppModel) async {
        unchanged = 0
        await fetch(app: app)
    }

    /// The next dashboard must be this account's (see expectedUsername).
    func expect(username: String?) {
        expectedUsername = username
    }

    /// Whether a dashboard is the account's: usernames are matched without
    /// regard to case, as the site's sign-in does.
    nonisolated static func belongs(_ dashboard: Dashboard, to username: String) -> Bool {
        dashboard.account.username.caseInsensitiveCompare(username) == .orderedSame
    }

    private func fetch(app: AppModel) async {
        // Signed out: whatever the cookies still say is the last account's.
        guard app.session == .signedIn else { return }
        generation += 1
        let generation = self.generation
        isLoading = true
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            var fresh = try await app.account.dashboard()
            var attempts = 0
            while let expected = expectedUsername, !Self.belongs(fresh, to: expected),
                  attempts < Self.mismatchRetries {
                attempts += 1
                // nativeGet kept it: not for the next launch to open on.
                OfflineStore.remove(.dashboard)
                try await Task.sleep(for: .seconds(Double(attempts)))
                guard generation == self.generation, app.session == .signedIn else { return }
                fresh = try await app.account.dashboard()
            }
            // Signed out meanwhile, and perhaps in again: not this account's.
            guard generation == self.generation, app.session == .signedIn else { return }
            if let expected = expectedUsername {
                guard Self.belongs(fresh, to: expected) else {
                    // Still the wrong account: nothing shown, nothing kept,
                    // and the next refresh checks again.
                    OfflineStore.remove(.dashboard)
                    error = .unavailable("signed in as someone else")
                    return
                }
                expectedUsername = nil
            }
            unchanged = fresh == data ? unchanged + 1 : 0
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
        unchanged = 0
        expectedUsername = nil
        isLoading = false
        data = nil
        updatedAt = nil
        error = nil
    }
}
