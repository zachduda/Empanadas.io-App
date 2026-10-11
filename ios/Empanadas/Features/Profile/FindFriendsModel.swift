import Foundation

/// State behind Find Friends: the search as typed, the players the site found
/// for it, and Add / Accept from the results. Searches are asked for as the
/// player types (FindFriendsView waits for a pause), and an answer for a
/// search that has since changed is dropped.
@MainActor
@Observable
final class FindFriendsModel {
    var query = ""
    private(set) var results: [PlayerSearch.Result] = []
    /// The search `results` are for.
    private(set) var searched: String?
    private(set) var hasMore = false
    private(set) var isSearching = false
    private(set) var error: AccountError?
    /// The player a change is being sent for.
    private(set) var working: String?
    var actionError: String?
    var needsCaptcha = false

    @ObservationIgnored private var page = 0
    /// Bumped by each new search: an answer to an older one is dropped.
    @ObservationIgnored private var generation = 0

    /// What the site would search for, or nil while there is too little.
    var term: String? { PlayerSearch.term(query) }

    func search(app: AppModel) async {
        guard let term else {
            generation += 1
            results = []
            searched = nil
            hasMore = false
            error = nil
            isSearching = false
            return
        }
        if term == searched && error == nil { return }

        generation += 1
        let generation = self.generation
        isSearching = true
        do {
            let found = try await app.account.searchPlayers(term)
            guard generation == self.generation else { return }
            results = found.results
            hasMore = found.hasMore
            page = 0
            searched = term
            error = nil
        } catch {
            // Cancelled: the player typed on, and the next search is coming.
            guard generation == self.generation, !Task.isCancelled else { return }
            fail(error, app: app)
        }
        isSearching = false
    }

    /// The next page, when the list has scrolled to its end.
    func loadMore(app: AppModel) async {
        guard hasMore, !isSearching, let searched else { return }
        let generation = self.generation
        isSearching = true
        do {
            let found = try await app.account.searchPlayers(searched, page: page + 1)
            guard generation == self.generation else { return }
            let seen = Set(results.map(\.id))
            results += found.results.filter { !seen.contains($0.id) }
            hasMore = found.hasMore
            page += 1
        } catch {
            guard generation == self.generation, !Task.isCancelled else {
                isSearching = false
                return
            }
            // The rows already found stay; the next scroll tries again.
            hasMore = false
            fail(error, app: app)
        }
        isSearching = false
    }

    private func fail(_ error: Error, app: AppModel) {
        let failure = error as? AccountError ?? .network
        if failure == .signedOut { app.observe(.unsure) }
        self.error = failure
    }

    // MARK: - Friends

    func add(_ result: PlayerSearch.Result, app: AppModel) async {
        await perform(result, becomes: .outgoing, app: app) {
            try await app.account.addFriend(result.playerID)
        }
    }

    func accept(_ result: PlayerSearch.Result, app: AppModel) async {
        await perform(result, becomes: .friends, app: app) {
            try await app.account.answerFriendRequest(from: result.playerID, accept: true)
        }
    }

    /// Sends the change, then shows the row in its new state rather than
    /// searching again (which would move the list under the player's finger).
    private func perform(_ result: PlayerSearch.Result, becomes relation: Relationship, app: AppModel,
                         _ change: () async throws -> Void) async {
        guard working == nil else { return }
        working = result.playerID
        defer { working = nil }
        do {
            try await change()
            Haptics.play("success")
            if let index = results.firstIndex(where: { $0.id == result.id }) {
                results[index].relation = relation
            }
            app.friendsChanged()
        } catch {
            Haptics.play("error")
            switch error as? AccountError {
            case .signedOut?:
                app.observe(.unsure)
            case .needsCaptcha?:
                needsCaptcha = true
            case let error?:
                actionError = error.localizedDescription
            case nil:
                actionError = AccountError.network.localizedDescription
            }
        }
    }
}
