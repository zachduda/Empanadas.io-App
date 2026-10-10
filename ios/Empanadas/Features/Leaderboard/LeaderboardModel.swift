import Foundation

/// State behind the native leaderboard. Same pattern as DashboardModel: the
/// saved boards first, then whatever the site has.
@MainActor
@Observable
final class LeaderboardModel {
    private(set) var board: Leaderboard?
    private(set) var updatedAt: Date?
    private(set) var isLoading = false
    private(set) var error: AccountError?

    init() {
        restore()
    }

    private func restore() {
        guard let saved = OfflineStore.load(Leaderboard.self, .leaderboard) else { return }
        board = saved.value
        updatedAt = saved.savedAt
    }

    func load(app: AppModel, maxAge: TimeInterval = 0) async {
        if error == nil, let updatedAt, Date().timeIntervalSince(updatedAt) < maxAge { return }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            board = try await app.account.leaderboard()
            updatedAt = Date()
            error = nil
        } catch let failure as AccountError {
            if failure == .signedOut { app.observe(.unsure) }
            error = failure
        } catch {
            self.error = .network
        }
    }

    /// How long to wait before asking again: when the site's shared cache
    /// will have a new build, as the web leaderboard paces itself.
    var pollInterval: TimeInterval {
        board?.pollInterval ?? 30
    }

    func reset() {
        board = nil
        updatedAt = nil
        error = nil
    }
}
