import Foundation

/// State behind the native Updates screen and the bell on Home: the site's
/// announcements, read from its public API one post at a time (the API's own
/// pace) as the player scrolls, and whether anything has been posted since
/// the player last looked.
///
/// What the player has seen is kept on the device: the newest post's id
/// when the feed last opened (Preferences.updatesSeenKey). The very first
/// time, the newest post counts as seen, as the site has a new account start
/// with everything read: the bell is for what is posted from then on, not
/// for every post there has ever been.
@MainActor
@Observable
final class UpdatesModel {
    /// The feed, newest first, as far down as it has been read.
    private(set) var posts: [Announcement] = []
    /// How many posts there are; nil until the site has said.
    private(set) var total: Int?
    /// The next post down to ask for.
    private(set) var nextPage = 0
    /// Bumped by every answer the feed takes: the end of the feed asks for
    /// the next post again each time, while it is on screen.
    private(set) var loads = 0
    private(set) var isLoading = false
    /// Why the last request for the feed failed; nil once one succeeds.
    private(set) var error: AccountError?
    /// Posts newer than the newest the player has seen: the bell's dot.
    private(set) var unread = 0

    /// The newest post the player had seen, and how many the bell counted,
    /// when the feed opened: the ones above it are marked New.
    private var seenWhenOpened: String?
    private var unreadWhenOpened = 0

    @ObservationIgnored private var loadedAt: Date?
    @ObservationIgnored private var checkedAt: Date?
    @ObservationIgnored private var isChecking = false
    /// Bumped by every read from the top: only the answers to the newest
    /// one's requests are kept.
    @ObservationIgnored private var generation = 0

    /// The id of the newest post the player has seen.
    private var lastSeen: String? {
        get { UserDefaults.standard.string(forKey: Preferences.updatesSeenKey) }
        set { UserDefaults.standard.set(newValue, forKey: Preferences.updatesSeenKey) }
    }

    /// Whether there are older posts still to read.
    var hasMore: Bool {
        guard let total else { return false }
        return nextPage < total
    }

    /// How many posts at the top of the feed are new to the player.
    var newCount: Int {
        Self.newCount(ids: posts.map(\.id), seen: seenWhenOpened, unread: unreadWhenOpened)
    }

    // MARK: - The bell

    /// Has anything been posted since the newest post the player has seen?
    /// At most every `maxAge` seconds: the site caches the answer for ten
    /// minutes anyway.
    func check(app: AppModel, maxAge: TimeInterval = 0) async {
        if let checkedAt, Date().timeIntervalSince(checkedAt) < maxAge { return }
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        // Signed out meanwhile (reset): the answer is not the next account's.
        let generation = self.generation

        guard let newest = try? await app.account.announcement(), generation == self.generation else { return }
        checkedAt = Date()
        guard let latest = newest.post else {
            unread = 0
            return
        }
        guard let seen = lastSeen else {
            lastSeen = latest.id
            unread = 0
            return
        }
        guard latest.id != seen else {
            unread = 0
            return
        }
        // How many are newer than the one last seen: where it now sits.
        let reply = try? await app.account.announcement(id: seen)
        // The feed opened meanwhile, and the player has read them.
        guard lastSeen == seen, generation == self.generation else { return }
        unread = Self.unread(newest: latest.id, seen: seen, seenAt: reply.flatMap { $0.post == nil ? nil : $0.page })
    }

    /// How many posts are new to the player: given the newest post's id,
    /// the newest they had seen, and how many posts are newer than that one
    /// (nil when it has been taken down).
    nonisolated static func unread(newest: String?, seen: String?, seenAt: Int?) -> Int {
        guard let newest, let seen, newest != seen else { return 0 }
        // Something is new, but not how much.
        guard let seenAt else { return 1 }
        return max(1, seenAt)
    }

    /// How many of the posts read so far (`ids`, newest first) are new: the
    /// ones above the newest the player had seen. Until the feed is read
    /// down to that one (or if it was taken down), as many as the bell
    /// counted, and at least the newest.
    nonisolated static func newCount(ids: [String], seen: String?, unread: Int) -> Int {
        guard let seen, !ids.isEmpty else { return 0 }
        if let index = ids.firstIndex(of: seen) { return index }
        return min(ids.count, max(1, unread))
    }

    // MARK: - The feed

    /// The feed coming on screen: read from the top, unless that was a few
    /// minutes ago and nothing new has come since. Coming back to it from a
    /// profile opened from a post keeps the place.
    func open(app: AppModel) async {
        if error == nil, unread == 0, !posts.isEmpty, let loadedAt, Date().timeIntervalSince(loadedAt) < 300 {
            return
        }
        seenWhenOpened = lastSeen
        unreadWhenOpened = unread
        await refresh(app: app)
    }

    /// The newest post again, and the feed down from there: as it opens, and
    /// pulled down (`fresh`, past the site's cache). Opening it reads the
    /// newest post: the bell goes quiet until the next.
    func refresh(app: AppModel, fresh: Bool = false) async {
        generation += 1
        let generation = self.generation
        isLoading = true
        error = nil
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            let reply = try await app.account.announcement(fresh: fresh)
            guard generation == self.generation else { return }
            posts = reply.post.map { [$0] } ?? []
            total = reply.post == nil ? 0 : reply.total
            nextPage = 1
            loadedAt = Date()
            if let newest = reply.post { lastSeen = newest.id }
            unread = 0
            loads += 1
        } catch {
            // Left the screen: it reads again when it comes back.
            guard generation == self.generation, !Task.isCancelled else { return }
            self.error = error as? AccountError ?? .network
        }
    }

    /// Signed out: the next account's bell and feed start from nothing. What
    /// has been seen is the device's (lastSeen), and stays.
    func reset() {
        generation += 1
        posts = []
        total = nil
        nextPage = 0
        isLoading = false
        error = nil
        unread = 0
        seenWhenOpened = nil
        unreadWhenOpened = 0
        loadedAt = nil
        checkedAt = nil
    }

    /// The next post down, as the end of the feed comes on screen.
    func loadMore(app: AppModel) async {
        guard hasMore, !isLoading else { return }
        let generation = self.generation
        let page = nextPage
        isLoading = true
        error = nil
        defer {
            if generation == self.generation { isLoading = false }
        }

        do {
            let reply = try await app.account.announcement(page: page)
            guard generation == self.generation else { return }
            nextPage = page + 1
            if let post = reply.post {
                total = reply.total
                // Something posted since the feed was read from the top
                // moves every post down one: this one is already showing.
                if !posts.contains(where: { $0.id == post.id }) { posts.append(post) }
            } else {
                // Past the last: some were taken down meanwhile.
                total = page
            }
            loads += 1
        } catch {
            // Scrolled away: it asks again when the end comes back.
            guard generation == self.generation, !Task.isCancelled else { return }
            self.error = error as? AccountError ?? .network
        }
    }
}
