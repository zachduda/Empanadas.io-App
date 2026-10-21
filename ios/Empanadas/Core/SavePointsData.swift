import Foundation

// The save points behind the Spin Progress chart, and putting the account
// back to one of them: what /v2/gamehistory.php sends. The site decides what
// a save point holds and what a restore changes (v2/_gamehistory.php there);
// its dashboard's "Manage game data" dialog (dashboard-v2_2.js) is the web's
// side of this screen. Decoding is lenient, as the dashboard's is.

/// The numbers a save point is listed by, and the account's now
/// (gameHistoryStats() on the site). Nil for a game with no save, and for
/// peppers when not known.
struct SaveStats: Decodable, Equatable {
    var prestige = 0
    var ascensions = 0
    var manualSpins = 0
    var peppers: Int?
    var flappyBest: Int?
    var towerBest: Int?

    enum CodingKeys: String, CodingKey {
        case prestige, ascensions, peppers
        case manualSpins = "manual_spins"
        case flappyBest = "flappy_best"
        case towerBest = "tower_best"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prestige = c.lenient(.prestige, 0)
        ascensions = c.lenient(.ascensions, 0)
        manualSpins = c.lenient(.manualSpins, 0)
        peppers = try? c.decodeIfPresent(Int.self, forKey: .peppers)
        flappyBest = try? c.decodeIfPresent(Int.self, forKey: .flappyBest)
        towerBest = try? c.decodeIfPresent(Int.self, forKey: .towerBest)
    }

    subscript(stat: SaveStat) -> Int? {
        switch stat {
        case .prestige: prestige
        case .ascensions: ascensions
        case .manualSpins: manualSpins
        case .peppers: peppers
        case .flappyBest: flappyBest
        case .towerBest: towerBest
        }
    }
}

/// What a save point is compared by, in the web dialog's order.
enum SaveStat: CaseIterable, Identifiable {
    case prestige
    case ascensions
    case manualSpins
    case peppers
    case flappyBest
    case towerBest

    var id: Self { self }

    var label: String {
        switch self {
        case .prestige: "Prestige"
        case .ascensions: "Ascensions"
        case .manualSpins: "Manual spins"
        case .peppers: "Peppers"
        case .flappyBest: "Flappy best"
        case .towerBest: "Tower best"
        }
    }

    /// Part of the Spin Game's save. A save point holding the Spin Game only
    /// leaves the others as they are.
    var isSpin: Bool {
        switch self {
        case .prestige, .ascensions, .manualSpins: true
        case .peppers, .flappyBest, .towerBest: false
        }
    }
}

/// How a save point's number compares with the account's now.
enum SaveTrend: Equatable {
    case higher
    case lower
    case same

    /// A game with no save counts as 0, as on the web (gdTrend()).
    init(_ value: Int?, now: Int?) {
        let then = value ?? 0, current = now ?? 0
        self = then > current ? .higher : (then < current ? .lower : .same)
    }
}

/// One game_history row, as gameHistoryPoint() on the site lists it.
struct SavePoint: Decodable, Identifiable, Equatable {
    var id: Int
    /// game_history.date, "2026-10-17 21:18:11", in the site's time.
    var date = ""
    /// The site's own way of writing it, "Oct 17, 2026 9:18 PM", for when
    /// `date` cannot be read.
    var label = ""
    /// "3 days ago", from the site, likewise.
    var ago = ""
    var stats = SaveStats()
    /// Holds the whole account: Flappy, Tower and the pepper balance as well
    /// as the Spin Game. Older rows hold the Spin Game only.
    var full = false
    /// False for one from before an anti-cheat reset, which the site will not
    /// put back.
    var restorable = true

    enum CodingKeys: String, CodingKey { case id, date, label, ago, full, restorable }

    init(id: Int) {
        self.id = id
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        date = c.lenient(.date, "")
        label = c.lenient(.label, "")
        ago = c.lenient(.ago, "")
        full = c.lenient(.full, false)
        restorable = c.lenient(.restorable, true)
        // The numbers sit beside the rest, not under a key of their own.
        stats = (try? SaveStats(from: decoder)) ?? SaveStats()
    }

    /// When it was saved, or nil when the site's date cannot be read.
    var savedAt: Date? { Self.siteDate(date) }

    /// Whether restoring it changes `stat` at all.
    func changes(_ stat: SaveStat) -> Bool {
        full || stat.isSpin
    }

    /// A "Y-m-d H:i:s" date from the site, which writes them in New York's
    /// time (nowNYString() in its v2/_lib.php).
    static func siteDate(_ text: String) -> Date? {
        let parts = text.split { $0 == "-" || $0 == " " || $0 == ":" }.map { Int($0) }
        guard parts.count == 6, let year = parts[0], let month = parts[1], let day = parts[2],
              let hour = parts[3], let minute = parts[4], let second = parts[5],
              (1...12).contains(month), (1...31).contains(day), (0...23).contains(hour),
              (0...59).contains(minute), (0...59).contains(second) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
        return calendar.date(from: DateComponents(year: year, month: month, day: day,
                                                  hour: hour, minute: minute, second: second))
    }
}

/// GET /v2/gamehistory.php: a page of save points, newest first, and the
/// account as it is now.
struct SavePointsPage: Decodable, Equatable {
    var current = SaveStats()
    var points: [SavePoint] = []
    /// Where the next page starts (?before=), or nil at the oldest.
    var before: Int?

    enum CodingKeys: String, CodingKey { case current, points, more, before }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = c.lenient(.current, SaveStats())
        // One row that will not read does not take the rest with it.
        points = c.lenient(.points, [LenientSavePoint]()).compactMap(\.point)
        let more = c.lenient(.more, false)
        before = more ? (try? c.decodeIfPresent(Int.self, forKey: .before)) : nil
    }

    private struct LenientSavePoint: Decodable {
        let point: SavePoint?

        init(from decoder: Decoder) throws {
            point = try? SavePoint(from: decoder)
        }
    }
}

/// POST /v2/gamehistory.php: a restore that went through.
struct RestoredSave: Decodable, Equatable {
    /// The whole account went back, not the Spin Game alone.
    var full = false
    /// What it replaced was kept as a new save point. False when the newest
    /// save point was already exactly that.
    var backup = false
    /// The account now.
    var current = SaveStats()

    enum CodingKeys: String, CodingKey { case full, backup, current }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        full = c.lenient(.full, false)
        backup = c.lenient(.backup, false)
        current = c.lenient(.current, SaveStats())
    }
}

/// What the player is told when /v2/gamehistory.php says no: gdFailText() in
/// the site's dashboard-v2_2.js.
enum SavePointsReason {
    static func message(_ reason: String) -> String {
        switch reason {
        case "unavailable": "Accounts are under maintenance right now. Try again in a little while."
        case "no_point": "That save point couldn't be found. Refresh the list and try again."
        case "anti_cheat": "That save point is from before an anti-cheat reset, so it can't be restored."
        // The App Review account's answer is already a sentence.
        case _ where reason.contains(" "): reason
        default: "Something went wrong on our end. Try again in a moment."
        }
    }

    /// A restore within GAME_HISTORY_COOLDOWN seconds of the last.
    static func cooldown(_ seconds: Int) -> String {
        let seconds = max(1, seconds)
        return "You just restored a save. Give it \(seconds) more \(seconds == 1 ? "second" : "seconds") and try again."
    }
}
