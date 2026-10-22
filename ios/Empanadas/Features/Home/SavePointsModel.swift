import Foundation

/// State behind the Manage Game Data screen: the account's save points, as
/// far down as they have been read, the account as it is now to compare them
/// with, and putting the account back to one of them (/v2/gamehistory).
/// Not kept for offline: a restore needs the site anyway, and the list is
/// read afresh each time the screen opens, as a game may have saved since.
@MainActor
@Observable
final class SavePointsModel {
    /// The account now; nil until the site has said.
    private(set) var current: SaveStats?
    /// Newest first.
    private(set) var points: [SavePoint] = []
    /// Where the next page starts; nil at the oldest.
    private(set) var before: Int?
    private(set) var isLoading = false
    /// Why the last read failed; nil once one succeeds.
    private(set) var error: AccountError?
    /// The save point being put back. One at a time.
    private(set) var restoring: Int?
    /// Bumped by every answer the list takes: its end asks for the next page
    /// again each time, while it is on screen.
    private(set) var loads = 0
    /// Bumped by every read from the top: only the answers to the newest
    /// one's requests are kept.
    @ObservationIgnored private var generation = 0

    var hasMore: Bool { before != nil }

    /// Some save points hold the Spin Game only.
    var hasSpinOnly: Bool { points.contains { !$0.full } }

    /// The newest page again: as the screen opens, pulled down, and after a
    /// restore (which adds a save point at the top).
    func refresh(app: AppModel) async {
        generation += 1
        let generation = self.generation
        isLoading = true
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            let page = try await app.account.savePoints()
            guard generation == self.generation else { return }
            current = page.current
            points = page.points
            before = page.before
            error = nil
            loads += 1
        } catch {
            failed(error, generation: generation, app: app)
        }
    }

    /// The next page down, as the end of the list comes on screen.
    func loadMore(app: AppModel) async {
        guard let before, !isLoading else { return }
        let generation = self.generation
        isLoading = true
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            let page = try await app.account.savePoints(before: before)
            guard generation == self.generation else { return }
            current = page.current
            // A game saving meanwhile adds rows at the top, not in here; but
            // a row is never listed twice.
            let listed = Set(points.map(\.id))
            points += page.points.filter { !listed.contains($0.id) }
            self.before = page.before
            error = nil
            loads += 1
        } catch {
            failed(error, generation: generation, app: app)
        }
    }

    private func failed(_ error: Error, generation: Int, app: AppModel) {
        // Left the screen: it reads again when it comes back.
        guard generation == self.generation, !Task.isCancelled else { return }
        let failure = error as? AccountError ?? .network
        if failure == .signedOut { app.observe(.unsure) }
        self.error = failure
    }

    /// Puts the account back to `point`: nil when it went through, else what
    /// to tell the player. Afterwards the list is read again (what was
    /// replaced is now the newest save point) and so is Home, whose every
    /// number was the old save's.
    func restore(_ point: SavePoint, app: AppModel) async -> String? {
        guard restoring == nil else { return nil }
        restoring = point.id
        let result: Result<RestoredSave, Error>
        do {
            let restored = try await app.account.restoreSavePoint(point.id)
            result = .success(restored)
        } catch {
            result = .failure(error)
        }
        restoring = nil

        switch result {
        case .success(let restored):
            current = restored.current
            Task { await app.dashboard.reload(app: app) }
            Task { await self.refresh(app: app) }
            return nil
        case .failure(let error):
            let failure = error as? AccountError ?? .network
            if failure == .signedOut { app.observe(.unsure) }
            // Whatever happened, the list should say how things stand now.
            Task { await self.refresh(app: app) }
            return failure == .network
                ? "Couldn't reach Empanadas.io. Check your connection and try again."
                : failure.localizedDescription
        }
    }
}
