import Foundation

// Built into the app and its Home Screen widget alike (project.yml): what the
// app tells the widget, and how the widget words a time.

/// What the Home Screen widget shows: each game, three of the player's
/// numbers in it and when it was last played in the app. The app writes it to
/// the App Group the two share whenever any of that changes (HomeScreenWidget
/// in the app), and the widget, which has none of the app's own code or data,
/// draws everything from it. None while signed out.
struct GamesSnapshot: Codable, Equatable {
    struct Entry: Codable, Equatable, Identifiable {
        /// "spin", "flappy" or "tower": the empanadas-io://play/<id> link.
        var id: String
        var title: String
        var subtitle: String
        var systemImage: String
        /// 0xRRGGBB.
        var tint: UInt32
        /// Already worded and formatted by the app ("280K"). Empty before
        /// the app has had a dashboard.
        var stats: [Stat]
        /// Nil if it has not been played in the app.
        var lastPlayed: Date?
    }

    struct Stat: Codable, Equatable {
        var label: String
        var text: String
    }

    var games: [Entry]

    /// The game played last, to jump back into; the first, when none has
    /// been played in the app yet.
    var featured: Entry? {
        games.filter { $0.lastPlayed != nil }
            .max { ($0.lastPlayed ?? .distantPast) < ($1.lastPlayed ?? .distantPast) } ?? games.first
    }

    /// Shared by the app and the widget. Has to be in both targets'
    /// entitlements, and registered for the team (ios/README.md).
    static let appGroup = "group.io.empanadas.app"
    static let key = "widget.games"

    static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func decode(_ data: Data?) -> GamesSnapshot? {
        data.flatMap { try? JSONDecoder().decode(GamesSnapshot.self, from: $0) }
    }

    /// The same snapshot always comes out the same, so the app can tell
    /// whether anything the widget shows has changed.
    func encoded() -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try? encoder.encode(self)
    }

    static func load() -> GamesSnapshot? {
        decode(defaults?.data(forKey: key))
    }

    /// Opens the game in the app (NativeRoute.of(deepLink:)).
    static func playURL(_ id: String) -> URL {
        URL(string: "empanadas-io://play/\(id)") ?? homeURL
    }

    static let homeURL = URL(string: "empanadas-io://home")!
}

/// How long ago a game was played, as the Games tab and the widget say it.
enum LastPlayed {
    /// "Played just now", "Played 2 hours ago", "Played yesterday". A time
    /// ahead of `now` (the clock was changed) is just now, not "in 2 hours".
    static func label(_ date: Date, now: Date = Date(), locale: Locale = .autoupdatingCurrent) -> String {
        let seconds = now.timeIntervalSince(date)
        guard seconds >= 60 else { return "Played just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.dateTimeStyle = .named
        formatter.unitsStyle = .full
        return "Played " + formatter.localizedString(for: date, relativeTo: now)
    }
}
