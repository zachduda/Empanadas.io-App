import Foundation

// What the native dashboard and leaderboard read from the site:
// /v2/app/dashboard.php (iosDashboard() and iosSpinHistory() in the site's
// v2/_lib.php) and /v2/app/leaderboard.php (leaderboard()). Decoding is
// lenient throughout, as AccountProfile's is: a field the site adds or drops
// later must not cost the player the whole screen. Only the name is required.

extension KeyedDecodingContainer {
    /// The value for `key`, or `fallback` when it is missing or the wrong type.
    func lenient<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }
}

struct Dashboard: Decodable, Equatable {
    struct Account: Decodable, Equatable {
        var username = ""
        var uuid = ""
        /// The large profile picture, usually a path on the site.
        var pfp: String?
        var hasCustomPfp = false
        var emailVerified = true
        /// Days since the account was created.
        var days = 0

        enum CodingKeys: String, CodingKey {
            case username, uuid, pfp, days
            case hasCustomPfp = "has_custom_pfp"
            case emailVerified = "email_verified"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            username = try c.decode(String.self, forKey: .username)
            uuid = c.lenient(.uuid, "")
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
            hasCustomPfp = c.lenient(.hasCustomPfp, false)
            emailVerified = c.lenient(.emailVerified, true)
            days = c.lenient(.days, 0)
        }
    }

    struct Spin: Decodable, Equatable {
        var lifetime = 0
        var prestige = 0
        var ascends = 0
        /// Spins in the current prestige.
        var spins = 0
        /// Towards ascending at prestige 100, 0...100.
        var progress = 0.0

        enum CodingKeys: String, CodingKey { case lifetime, prestige, ascends, spins, progress }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            lifetime = c.lenient(.lifetime, 0)
            prestige = c.lenient(.prestige, 0)
            ascends = c.lenient(.ascends, 0)
            spins = c.lenient(.spins, 0)
            progress = c.lenient(.progress, 0.0)
        }
    }

    /// Flappy and Tower: a best, the last round, and how many were played.
    struct Score: Decodable, Equatable {
        var high = 0
        var recent = 0
        var played = 0
        /// The last round against the best, 0...100.
        var progress = 0.0

        enum CodingKeys: String, CodingKey { case high, recent, played, progress }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            high = c.lenient(.high, 0)
            recent = c.lenient(.recent, 0)
            played = c.lenient(.played, 0)
            progress = c.lenient(.progress, 0.0)
        }
    }

    struct Experience: Decodable, Equatable {
        var total = 0
        var rank = ""
        /// An emoji.
        var icon = ""
        /// XP where the next rank starts; nil at the top rank.
        var next: Int?
        var nextRank: String?
        /// Through the current rank, 0...100.
        var progress = 0.0

        enum CodingKeys: String, CodingKey {
            case total, rank, icon, next, progress
            case nextRank = "next_rank"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            total = c.lenient(.total, 0)
            rank = c.lenient(.rank, "")
            icon = c.lenient(.icon, "")
            next = try? c.decodeIfPresent(Int.self, forKey: .next)
            nextRank = try? c.decodeIfPresent(String.self, forKey: .nextRank)
            progress = c.lenient(.progress, 0.0)
        }
    }

    struct Friend: Decodable, Equatable, Identifiable {
        var username = ""
        var uuid = ""
        var pfp: String?
        var defaultPfp = false
        /// "online", "idle" or "offline".
        var state = "offline"
        /// "Online", "Idle", "3 days ago".
        var label = ""

        var id: String { uuid.isEmpty ? username : uuid }

        enum CodingKeys: String, CodingKey {
            case username, uuid, pfp, state, label
            case defaultPfp = "default_pfp"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            username = c.lenient(.username, "")
            uuid = c.lenient(.uuid, "")
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
            defaultPfp = c.lenient(.defaultPfp, false)
            state = c.lenient(.state, "offline")
            label = c.lenient(.label, "")
        }
    }

    struct Friends: Decodable, Equatable {
        var total = 0
        var online = 0
        /// Requests waiting on this player.
        var pending = 0
        var list: [Friend] = []

        enum CodingKeys: String, CodingKey { case total, online, pending, list }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            total = c.lenient(.total, 0)
            online = c.lenient(.online, 0)
            pending = c.lenient(.pending, 0)
            list = c.lenient(.list, [])
        }
    }

    /// One day of the Spin Progress chart: lifetime spins at the end of it.
    struct SpinDay: Decodable, Equatable {
        /// "2026-10-01", in the site's time zone.
        var date: String
        var spins: Int
    }

    /// The daily reward (dailyStatus() in the site's v2/_daily.php): the
    /// streak, today's day of it, and the seven days the card shows.
    /// Claimed through /v2/app/daily.php (AccountAPI.claimDailyReward()).
    struct Daily: Decodable, Equatable {
        struct Day: Decodable, Equatable, Identifiable {
            var day = 1
            var reward = 0
            var done = false
            var today = false

            var id: Int { day }

            enum CodingKeys: String, CodingKey { case day, reward, done, today }

            init(day: Int, reward: Int, done: Bool, today: Bool) {
                self.day = day
                self.reward = reward
                self.done = done
                self.today = today
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                day = c.lenient(.day, 1)
                reward = c.lenient(.reward, 0)
                done = c.lenient(.done, false)
                today = c.lenient(.today, false)
            }
        }

        var claimed = false
        /// Days in a row, today's claim counted once made; 0 once a day was missed.
        var streak = 0
        /// The day of the streak today is.
        var day = 1
        /// What today pays (or paid).
        var reward = 10
        /// What tomorrow pays if the streak goes on.
        var tomorrow = 10
        var best = 0
        var total = 0
        var week: [Day] = []
        var baseReward = 10
        var streakReward = 50
        /// The day of a streak the bigger reward starts on.
        var streakDays = 7
        /// Seconds until the site's next day, once today is claimed.
        var nextIn: Int?

        enum CodingKeys: String, CodingKey {
            case claimed, streak, day, reward, tomorrow, best, total, week
            case baseReward = "base_reward"
            case streakReward = "streak_reward"
            case streakDays = "streak_days"
            case nextIn = "next_in"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            claimed = c.lenient(.claimed, false)
            streak = c.lenient(.streak, 0)
            day = c.lenient(.day, 1)
            reward = c.lenient(.reward, 10)
            tomorrow = c.lenient(.tomorrow, 10)
            best = c.lenient(.best, 0)
            total = c.lenient(.total, 0)
            week = c.lenient(.week, [])
            baseReward = c.lenient(.baseReward, 10)
            streakReward = c.lenient(.streakReward, 50)
            streakDays = c.lenient(.streakDays, 7)
            nextIn = try? c.decodeIfPresent(Int.self, forKey: .nextIn)
        }

        /// Past the first week of a streak, every day pays the bigger reward.
        var isOnFire: Bool { streak >= streakDays }

        /// Claimed, but the site's day has turned over since `asOf` (when the
        /// answer came): today is claimable again. Home asks the site anyway
        /// once a minute; this keeps the card from saying "come back
        /// tomorrow" past midnight meanwhile.
        func isDueAgain(asOf: Date?, now: Date = Date()) -> Bool {
            guard claimed, let nextIn, let asOf else { return false }
            return now >= asOf.addingTimeInterval(TimeInterval(nextIn))
        }

        /// When the next reward is due, from an answer that came at `asOf`.
        func nextRewardAt(asOf: Date?) -> Date? {
            guard claimed, let nextIn, let asOf else { return nil }
            return asOf.addingTimeInterval(TimeInterval(nextIn))
        }
    }

    var account: Account
    var peppers = 0
    var pumpkins = 0
    var spin = Spin()
    var flappy = Score()
    var tower = Score()
    var xp = Experience()
    var friends = Friends()
    var spinHistory: [SpinDay] = []
    /// Nil from a site without the daily reward, or when it could not be read:
    /// Home then leaves the card out.
    var daily: Daily?

    enum CodingKeys: String, CodingKey {
        case account, peppers, pumpkins, spin, flappy, tower, xp, friends, daily
        case spinHistory = "spin_history"
    }

    init(account: Account) {
        self.account = account
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        account = try c.decode(Account.self, forKey: .account)
        peppers = c.lenient(.peppers, 0)
        pumpkins = c.lenient(.pumpkins, 0)
        spin = c.lenient(.spin, Spin())
        flappy = c.lenient(.flappy, Score())
        tower = c.lenient(.tower, Score())
        xp = c.lenient(.xp, Experience())
        friends = c.lenient(.friends, Friends())
        // One bad day must not take the rest of the chart with it.
        spinHistory = (c.lenient(.spinHistory, [LenientDay]())).compactMap(\.day)
        daily = try? c.decodeIfPresent(Daily.self, forKey: .daily)
    }

    var pictureURL: URL? { SiteURLs.resolve(account.pfp) }

    func score(for game: Game) -> Score? {
        switch game {
        case .spin: nil
        case .flappy: flappy
        case .tower: tower
        }
    }

    /// The three numbers the Games tab shows under a game.
    func quickStats(for game: Game) -> [GameStat] {
        switch game {
        case .spin:
            [GameStat(label: "Spins", value: spin.lifetime),
             GameStat(label: "Prestige", value: spin.prestige),
             GameStat(label: "Ascensions", value: spin.ascends)]
        case .flappy:
            [GameStat(label: "Best", value: flappy.high),
             GameStat(label: "Last", value: flappy.recent),
             GameStat(label: "Rounds", value: flappy.played)]
        case .tower:
            [GameStat(label: "Tallest", value: tower.high),
             GameStat(label: "Last", value: tower.recent),
             GameStat(label: "Runs", value: tower.played)]
        }
    }

    /// Whether the site has the player down as having played the game at
    /// all, on any device.
    func hasPlayed(_ game: Game) -> Bool {
        switch game {
        case .spin: spin.lifetime > 0 || spin.ascends > 0
        case .flappy: flappy.played > 0 || flappy.high > 0
        case .tower: tower.played > 0 || tower.high > 0
        }
    }
}

/// One of the numbers under a game on the Games tab.
struct GameStat: Equatable {
    let label: String
    let value: Int

    var text: String { Self.format(value) }

    /// Whole up to 9,999, short past that ("280K"), so three fit side by side
    /// under a game on a phone.
    static func format(_ value: Int, locale: Locale = .autoupdatingCurrent) -> String {
        if abs(value) < 10_000 { return value.formatted(.number.locale(locale)) }
        return value.formatted(.number.notation(.compactName).locale(locale))
    }
}

/// Decodes a chart day without throwing, so a malformed one is dropped alone.
private struct LenientDay: Decodable {
    let day: Dashboard.SpinDay?

    init(from decoder: Decoder) throws {
        day = try? Dashboard.SpinDay(from: decoder)
    }
}

// MARK: - Spin Progress chart

struct SpinPoint: Identifiable, Equatable {
    /// Noon on the day, local time: clear of any daylight saving edge.
    let date: Date
    /// Lifetime spins at the end of the day.
    let total: Int
    /// Spins since the point before (0 for the first).
    let gained: Int

    var id: Date { date }
}

enum SpinHistory {
    enum Range: String, CaseIterable, Identifiable {
        case week = "1W"
        case month = "1M"
        case quarter = "3M"
        case year = "1Y"
        case all = "All"

        var id: Self { self }

        var days: Int? {
            switch self {
            case .week: 7
            case .month: 30
            case .quarter: 91
            case .year: 365
            case .all: nil
            }
        }

        var label: String {
            switch self {
            case .week: "this week"
            case .month: "this month"
            case .quarter: "in 3 months"
            case .year: "this year"
            case .all: "all time"
            }
        }
    }

    static func points(_ days: [Dashboard.SpinDay], calendar: Calendar = .current) -> [SpinPoint] {
        var dated: [(Date, Int)] = []
        for day in days {
            let parts = day.date.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3,
                  let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
            else { continue }
            dated.append((date, max(0, day.spins)))
        }
        dated.sort { $0.0 < $1.0 }

        var out: [SpinPoint] = []
        var previous: Int?
        for (date, total) in dated {
            out.append(SpinPoint(date: date, total: total, gained: previous.map { max(0, total - $0) } ?? 0))
            previous = total
        }
        return out
    }

    /// The first day a range shows, or nil for all of it. Today counts as
    /// one of its days: 1W is today and the six before it.
    static func firstDay(of range: Range, now: Date, calendar: Calendar = .current) -> Date? {
        guard let days = range.days else { return nil }
        return calendar.date(byAdding: .day, value: 1 - days, to: calendar.startOfDay(for: now))
    }

    static func points(_ points: [SpinPoint], in range: Range, now: Date, calendar: Calendar = .current) -> [SpinPoint] {
        guard let start = firstDay(of: range, now: now, calendar: calendar) else { return points }
        return points.filter { $0.date >= start }
    }

    /// Spins earned over a range: the last total less the one standing when
    /// the range began (the last day before it, else its own first day).
    static func gained(_ points: [SpinPoint], in range: Range, now: Date, calendar: Calendar = .current) -> Int {
        guard let last = points.last else { return 0 }
        guard let start = firstDay(of: range, now: now, calendar: calendar) else {
            return max(0, last.total - (points.first?.total ?? last.total))
        }
        let base = points.last(where: { $0.date < start }) ?? points.first(where: { $0.date >= start }) ?? last
        return max(0, last.total - base.total)
    }
}

// MARK: - Leaderboard

struct Leaderboard: Decodable, Equatable {
    struct Row: Decodable, Equatable, Identifiable {
        var rank = 0
        /// The player's profile id.
        var uuid = ""
        var username = ""
        var pfp: String?
        var defaultPfp = false
        /// A private profile keeps its place and name, but not its numbers.
        var isPrivate = false
        var score: Int?
        var ascends: Int?
        var prestige: Int?
        var recent: Int?

        var id: String { "\(rank)-\(uuid)" }

        enum CodingKeys: String, CodingKey {
            case rank, username, pfp, score, ascends, prestige, recent
            case uuid = "id"
            case defaultPfp = "default_pfp"
            case isPrivate = "private"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            rank = c.lenient(.rank, 0)
            uuid = c.lenient(.uuid, "")
            username = c.lenient(.username, "")
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
            defaultPfp = c.lenient(.defaultPfp, false)
            isPrivate = c.lenient(.isPrivate, false)
            score = try? c.decodeIfPresent(Int.self, forKey: .score)
            ascends = try? c.decodeIfPresent(Int.self, forKey: .ascends)
            prestige = try? c.decodeIfPresent(Int.self, forKey: .prestige)
            recent = try? c.decodeIfPresent(Int.self, forKey: .recent)
        }

        var pictureURL: URL? { SiteURLs.resolve(pfp) }

        /// The line under the name, as the site's leaderboard.js writes it.
        func detail(for game: Game) -> String {
            if isPrivate { return "Private profile" }
            switch game {
            case .spin:
                var bits: [String] = []
                if let ascends, ascends > 0 {
                    bits.append("\(ascends.formatted()) ascension\(ascends == 1 ? "" : "s")")
                }
                if let prestige, prestige > 0 { bits.append("Prestige \(prestige.formatted())") }
                return bits.joined(separator: " · ")
            case .flappy:
                guard let recent, recent > 0 else { return "" }
                return "Last run: \(recent.formatted())"
            case .tower:
                guard let recent, recent > 0 else { return "" }
                return "Last run: \(recent.formatted()) floor\(recent == 1 ? "" : "s")"
            }
        }
    }

    var spin: [Row] = []
    var flappy: [Row] = []
    var tower: [Row] = []
    /// The player's own profile id, to mark their row.
    var you = ""
    /// Where the player stands on each board ("spin", "flappy", "tower"),
    /// however far down: the boards themselves stop at ten. Missing for a
    /// board they're not on, and from a site that doesn't send it yet.
    var places: [String: Int] = [:]
    /// When the site built these boards (Unix time).
    var generated = 0
    /// How old the build was when it was sent, and how long builds last.
    var age = 0
    var ttl = 45

    enum CodingKeys: String, CodingKey { case spin, flappy, tower, you, places, generated, age, ttl }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spin = c.lenient(.spin, [])
        flappy = c.lenient(.flappy, [])
        tower = c.lenient(.tower, [])
        you = c.lenient(.you, "")
        // Nulls (not on that board) are left out rather than failing the lot.
        places = c.lenient(.places, [String: Int?]()).compactMapValues { $0 }
        generated = c.lenient(.generated, 0)
        age = c.lenient(.age, 0)
        ttl = c.lenient(.ttl, 45)
    }

    func rows(for game: Game) -> [Row] {
        switch game {
        case .spin: spin
        case .flappy: flappy
        case .tower: tower
        }
    }

    func isYou(_ row: Row) -> Bool {
        !you.isEmpty && row.uuid.lowercased() == you.lowercased()
    }

    /// The player's place on a board: their row's, when the board lists them,
    /// else the site's count; nil when they aren't on it.
    func place(on game: Game) -> Int? {
        if let row = rows(for: game).first(where: isYou) { return row.rank }
        return places[game.rawValue].flatMap { $0 > 0 ? $0 : nil }
    }

    var generatedAt: Date? {
        generated > 0 ? Date(timeIntervalSince1970: TimeInterval(generated)) : nil
    }

    /// Seconds until the site's cache has a new build to collect, kept between
    /// 15 seconds and 2 minutes, as leaderboard.js paces itself.
    var pollInterval: TimeInterval {
        min(120, max(15, TimeInterval(ttl - age + 2)))
    }

    /// The word after a score.
    static func unit(for game: Game) -> String {
        switch game {
        case .spin: "Spins"
        case .flappy: "Points"
        case .tower: "Floors"
        }
    }
}

/// When pumpkins turn up around the site: September and October, in the
/// site's time zone (pumpkin_season in the site's v2/_lib.php). The screens
/// ask the clock rather than the answer they're showing, which may have been
/// saved in October and shown offline in November; the site's pumpkin_season
/// is not read. Out of season the pumpkins aren't shown at all.
enum PumpkinSeason {
    static func contains(_ date: Date) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
        let month = calendar.component(.month, from: date)
        return month == 9 || month == 10
    }

    static var isNow: Bool { contains(.now) }
}

/// What /v2/app/daily.php answers a claim with: the peppers paid (0 when today
/// was already claimed, on another device perhaps), the balance after, and
/// the reward as it now stands.
struct DailyClaim: Decodable, Equatable {
    var granted = 0
    /// Nil when nothing was paid.
    var peppers: Int?
    var daily: Dashboard.Daily

    enum CodingKeys: String, CodingKey { case granted, peppers, daily }

    init(granted: Int, peppers: Int?, daily: Dashboard.Daily) {
        self.granted = granted
        self.peppers = peppers
        self.daily = daily
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        granted = c.lenient(.granted, 0)
        peppers = try? c.decodeIfPresent(Int.self, forKey: .peppers)
        daily = try c.decode(Dashboard.Daily.self, forKey: .daily)
    }
}
