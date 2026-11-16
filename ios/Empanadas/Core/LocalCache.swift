import Foundation

/// What the app keeps to itself rather than ask the site again: when each
/// picture was last checked, the profiles looked at this session, the pace of
/// the dashboard's refresh, and how old an answer may be before a screen
/// coming back asks for a new one.

/// How old an answer may be, in seconds, before the screen it is on asks the
/// site again without being told to. Pulling down always asks.
enum CacheAge {
    /// The dashboard, as Home or Games comes back on screen: its own pace
    /// while showing is a minute (DashboardPace).
    static let dashboard: TimeInterval = 60
    /// The boards, for the places on the Games tab's cards. The Leaderboards
    /// tab goes by the site's own cache (LeaderboardModel.sinceBuild).
    static let gamesLeaderboard: TimeInterval = 5 * 60
    /// The account (Settings, and the theme as the app comes to the front).
    static let account: TimeInterval = 5 * 60
    /// Someone else's profile, opened again.
    static let profile: TimeInterval = 60
    /// The Send Feedback form: its subjects and the reply address.
    static let feedbackForm: TimeInterval = 10 * 60
    /// A search already made, typed again.
    static let search: TimeInterval = 60
}

// MARK: - Pictures

/// When each picture was last fetched from the site or checked with it. One
/// checked within `maxAge` is drawn from the copy on disk without asking: a
/// launch otherwise asks about every face on the dashboard, the boards and
/// the friends list, each its own request, to be told almost every time that
/// nothing changed.
struct PictureFreshness: Codable, Equatable {
    /// A day: a friend's new picture shows by tomorrow. The player's own is
    /// asked for again as soon as they have been to the picture page
    /// (AppModel.pictureMayHaveChanged).
    static let maxAge: TimeInterval = 24 * 60 * 60
    /// More than this many and the older half is forgotten: those pictures
    /// are asked about again, which is all forgetting one costs.
    static let limit = 2000

    private(set) var checked: [String: Date] = [:]

    var count: Int { checked.count }

    func isFresh(_ url: URL, now: Date = Date(), maxAge: TimeInterval = PictureFreshness.maxAge) -> Bool {
        guard let at = checked[url.absoluteString] else { return false }
        let age = now.timeIntervalSince(at)
        // A date in the future is the clock having been set back: not fresh.
        return age >= 0 && age < maxAge
    }

    mutating func mark(_ url: URL, now: Date = Date()) {
        checked[url.absoluteString] = now
        guard checked.count > Self.limit else { return }
        let newest = checked.sorted { $0.value > $1.value }.prefix(Self.limit / 2)
        checked = Dictionary(uniqueKeysWithValues: newest.map { ($0.key, $0.value) })
    }

    mutating func forget(_ url: URL) {
        checked[url.absoluteString] = nil
    }
}

// MARK: - Profiles

/// Other players' profiles as last read this session, so one opened again (a
/// friend from Home, then from a board, then back from their friends list)
/// is on screen at once, and is not asked for again while it is fresh. In
/// memory only: what the site shows of someone depends on who is asking and
/// on their privacy settings as they are now, so none of it outlives the
/// session or the app. The player's own profile is kept on disk instead
/// (OfflineStore).
@MainActor
enum ProfileCache {
    struct Entry {
        let profile: PlayerProfile
        let readAt: Date
    }

    /// The most recently read, last. A hundred profiles is a long session.
    static let limit = 100
    private static var entries: [String: Entry] = [:]
    private static var order: [String] = []

    /// The same player however the id was written (dashes, capitals).
    private static func cacheKey(_ id: String) -> String {
        PlayerID.raw(id) ?? id.lowercased()
    }

    static func entry(for id: String) -> Entry? {
        entries[cacheKey(id)]
    }

    static func keep(_ profile: PlayerProfile, for id: String, now: Date = Date()) {
        let key = cacheKey(id)
        entries[key] = Entry(profile: profile, readAt: now)
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > limit {
            entries[order.removeFirst()] = nil
        }
    }

    /// One profile, when what it showed is known to be out of date (a
    /// friend request sent from a search result).
    static func forget(_ id: String) {
        let key = cacheKey(id)
        entries[key] = nil
        order.removeAll { $0 == key }
    }

    /// At sign-out, and when the player's friends change: every profile says
    /// where the player stands with its owner and lists friends in common.
    static func clear() {
        entries = [:]
        order = []
    }
}

// MARK: - The dashboard's pace

/// How long Home waits between refreshes while it is showing: a minute, as
/// the site's dashboard refreshes its friends list, and longer the longer
/// nothing has changed. An app left open on Home asked once a minute for as
/// long as it was open, for the same answer.
enum DashboardPace {
    static let base: TimeInterval = 60
    static let longest: TimeInterval = 5 * 60

    /// `unchanged`: how many answers in a row were the same as the one
    /// before. The first two cost nothing; from there the wait doubles, up
    /// to five minutes. Anything changing (a friend coming online, a round
    /// played) or the player pulling down starts it at a minute again.
    static func interval(unchanged: Int) -> TimeInterval {
        guard unchanged > 2 else { return base }
        let doublings = min(unchanged - 2, 8)
        return min(longest, base * pow(2, Double(doublings)))
    }
}
