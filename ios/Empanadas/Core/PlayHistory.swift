import Foundation

/// When each game was last played in the app, kept on the device: the Games
/// tab's "Played 2 hours ago" and its Jump Back In. The site keeps no such
/// time (a save has none), so a round played on the website or the desktop
/// app does not count here. Cleared at sign-out with the rest of what
/// describes the account (AppModel.setSession).
enum PlayHistory {
    static func load(from defaults: UserDefaults = .standard) -> [Game: Date] {
        let saved = defaults.dictionary(forKey: Preferences.playHistoryKey) ?? [:]
        var history: [Game: Date] = [:]
        for (name, value) in saved {
            if let game = Game(rawValue: name), let date = value as? Date { history[game] = date }
        }
        return history
    }

    static func save(_ history: [Game: Date], to defaults: UserDefaults = .standard) {
        let saved = Dictionary(uniqueKeysWithValues: history.map { ($0.key.rawValue, $0.value) })
        defaults.set(saved, forKey: Preferences.playHistoryKey)
    }

    static func clear(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: Preferences.playHistoryKey)
    }

    /// The game played most recently, and when.
    static func latest(_ history: [Game: Date]) -> (game: Game, date: Date)? {
        history.max { $0.value < $1.value }.map { (game: $0.key, date: $0.value) }
    }

    /// "Played just now", "Played 2 hours ago", "Played yesterday"
    /// (LastPlayed, which the widget words its times with too).
    static func label(_ date: Date, now: Date = Date(), locale: Locale = .autoupdatingCurrent) -> String {
        LastPlayed.label(date, now: now, locale: locale)
    }

    /// The games, the one played last first, then the rest played here, then
    /// those never played here in the usual order: the Home Screen quick
    /// actions.
    static func ordered(_ history: [Game: Date]) -> [Game] {
        Game.allCases.enumerated()
            .sorted { a, b in
                switch (history[a.element], history[b.element]) {
                case let (x?, y?): x > y
                case (.some, nil): true
                case (nil, .some): false
                case (nil, nil): a.offset < b.offset
                }
            }
            .map(\.element)
    }
}
