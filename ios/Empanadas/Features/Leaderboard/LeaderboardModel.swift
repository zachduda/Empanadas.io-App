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
        let generation = self.generation
        isLoading = true
        // Not for a request from before a sign-out: reset() has already
        // cleared it, and the next account's first load may be under way.
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            let fresh = try await app.account.leaderboard()
            guard generation == self.generation else { return }
            board = fresh
            updatedAt = Date()
            error = nil
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
        // A request still out for the last account would otherwise hold off
        // the next one's first load (load() waits while one is loading).
        isLoading = false
    }
}
