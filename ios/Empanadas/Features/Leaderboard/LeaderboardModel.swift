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
    /// Bumped by reset(), as DashboardModel's.
    @ObservationIgnored private var generation = 0

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

        let generation = self.generation
        do {
            let fresh = try await app.account.leaderboard()
            guard generation == self.generation else { return }
            board = fresh
            updatedAt = Date()
            error = nil
        } catch let failure as AccountError {
            guard generation == self.generation else { return }
            if failure == .signedOut { app.observe(.unsure) }
            error = failure
        } catch {
            guard generation == self.generation else { return }
            self.error = .network
        }
    }

    /// How long to wait before asking again: when the site's shared cache
    /// will have a new build, as the web leaderboard paces itself.
    var pollInterval: TimeInterval {
        board?.pollInterval ?? 30
    }

    func reset() {
        generation += 1
        board = nil
        updatedAt = nil
        error = nil
    }
}
