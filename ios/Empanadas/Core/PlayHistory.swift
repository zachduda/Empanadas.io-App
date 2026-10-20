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
