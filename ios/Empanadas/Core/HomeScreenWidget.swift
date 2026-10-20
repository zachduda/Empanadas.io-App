import WidgetKit

/// Keeps the Home Screen widget (EmpanadasWidget) up to date: writes what it
/// shows (GamesSnapshot) to the App Group the two share, and asks it to
/// redraw, but only when something it shows has changed. The dashboard
/// refreshes every minute while Home is up, and WidgetKit rations how often a
/// widget may be reloaded.
@MainActor
enum HomeScreenWidget {
    /// Signed in: the games, with the dashboard's numbers (nil before it has
    /// come) and when each was last played here.
    static func update(dashboard: Dashboard?, lastPlayed: [Game: Date]) {
        save(snapshot(dashboard: dashboard, lastPlayed: lastPlayed))
    }

    /// Signed out: the widget asks the player to sign in, rather than keep
    /// showing the last account's numbers.
    static func clear() {
        save(nil)
    }

    nonisolated static func snapshot(dashboard: Dashboard?, lastPlayed: [Game: Date]) -> GamesSnapshot {
        GamesSnapshot(games: Game.allCases.map { game in
            GamesSnapshot.Entry(
                id: game.rawValue,
                title: game.title,
                subtitle: game.subtitle,
                systemImage: game.systemImage,
                tint: game.tintHex,
                stats: dashboard?.quickStats(for: game).map { GamesSnapshot.Stat(label: $0.label, text: $0.text) } ?? [],
                lastPlayed: lastPlayed[game]
            )
        })
    }

    private static func save(_ snapshot: GamesSnapshot?) {
        guard let defaults = GamesSnapshot.defaults else { return }
        let data = snapshot?.encoded()
        guard data != defaults.data(forKey: GamesSnapshot.key) else { return }
        if let data {
            defaults.set(data, forKey: GamesSnapshot.key)
        } else {
            defaults.removeObject(forKey: GamesSnapshot.key)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
