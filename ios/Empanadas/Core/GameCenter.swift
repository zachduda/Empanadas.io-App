import GameKit
import UIKit

extension Game {
    /// The game's leaderboard in Game Center. Each has to exist in App Store
    /// Connect under exactly this ID (ios/README.md, "Game Center").
    var gameCenterLeaderboardID: String {
        "io.empanadas.app.leaderboard." + rawValue
    }
}

extension Dashboard {
    /// What goes on the game's Game Center leaderboard: the number the site's
    /// board for it ranks by (leaderboardBuild() in its v2/_lib.php), so both
    /// boards agree. Lifetime Spins, and the best Flappy and Tower rounds.
    func leaderboardScore(for game: Game) -> Int {
        switch game {
        case .spin: spin.lifetime
        case .flappy: flappy.high
        case .tower: tower.high
        }
    }
}

/// Game Center's leaderboards, next to the site's. The scores are the ones
/// the site keeps, not the games': each fresh dashboard (DashboardModel)
/// brings the player's numbers, and whatever changed since the last report
/// goes to Game Center. So it is the same ranking as the Leaderboard tab, and
/// a best set on the website or the desktop app gets there too.
///
/// A player not signed in to Game Center on the device gets GameKit's sign-in
/// screen only when they ask for it (signIn: Settings, or the Leaderboard
/// tab's Game Center button), not put in front of them unasked.
@MainActor
@Observable
final class GameCenter {
    /// Signed in to Game Center on this device, and allowed to use it.
    private(set) var isSignedIn = false
    /// Their Game Center name.
    private(set) var playerName: String?
    /// GameKit has a sign-in screen to show (signInController).
    private(set) var canSignIn = false
    @ObservationIgnored private var signInController: UIViewController?

    /// The player's choice in Settings. On unless they turned it off.
    var postsScores: Bool {
        didSet {
            UserDefaults.standard.set(postsScores, forKey: Preferences.gameCenterScoresKey)
            if postsScores { flush() }
        }
    }

    @ObservationIgnored private var started = false
    /// The newest score for each leaderboard, until it has been reported.
    @ObservationIgnored private var pending: [String: Int] = [:]
    @ObservationIgnored private var isReporting = false
    /// Bumped by reset(), as DashboardModel's: what failed to go out before a
    /// sign-out is not kept for later.
    @ObservationIgnored private var generation = 0

    init() {
        postsScores = UserDefaults.standard.object(forKey: Preferences.gameCenterScoresKey) as? Bool ?? true
    }

    /// Signs in to Game Center, once, when the player has signed in to the
    /// app. GameKit calls the handler again whenever that changes (signed in
    /// or out in the Settings app while this one was in the background).
    func start() {
        guard !started else { return }
        started = true
        GKLocalPlayer.local.authenticateHandler = { [weak self] controller, _ in
            Task { @MainActor in self?.authenticated(controller) }
        }
    }

    private func authenticated(_ controller: UIViewController?) {
        signInController = controller
        canSignIn = controller != nil
        let player = GKLocalPlayer.local
        isSignedIn = player.isAuthenticated
        playerName = player.isAuthenticated ? player.displayName : nil
        flush()
    }

    /// GameKit's own sign-in screen. Once the player is in, the handler runs
    /// again and the scores waiting go out.
    func signIn() {
        guard let controller = signInController else { return }
        signInController = nil
        canSignIn = false
        Dialogs.present(controller)
    }

    /// Game Center, on the game's leaderboard (on iOS 17, its leaderboards).
    func showLeaderboard(for game: Game) {
        guard isSignedIn else {
            signIn()
            return
        }
        if #available(iOS 18.0, *) {
            GKAccessPoint.shared.trigger(leaderboardID: game.gameCenterLeaderboardID,
                                         playerScope: .global, timeScope: .allTime)
        } else {
            GKAccessPoint.shared.trigger(state: .leaderboards) {}
        }
    }

    // MARK: - Scores

    /// A fresh dashboard: its scores go to Game Center if they changed, now
    /// or once the player is signed in there.
    func report(_ dashboard: Dashboard) {
        for game in Game.allCases {
            pending[game.gameCenterLeaderboardID] = dashboard.leaderboardScore(for: game)
        }
        flush()
    }

    /// Signed out of the app: the last account's scores must not go out
    /// later under the next one.
    func reset() {
        generation += 1
        pending = [:]
    }

    /// Of `scores`, the ones to report: those not already on their leaderboard
    /// as last reported. A zero never is (a game not played yet has no place
    /// on a board). A lower score than before still is, if a different
    /// account signed in: Game Center keeps the best either way.
    nonisolated static func due(_ scores: [String: Int], reported: [String: Int]) -> [String: Int] {
        scores.filter { $0.value > 0 && reported[$0.key] != $0.value }
    }

    /// What was last reported to each leaderboard, for this Game Center
    /// player, so the dashboard's refresh (every minute while Home is up)
    /// reports only what changed. Kept across launches and sign-outs: it
    /// describes Game Center, not the account.
    private static func reportedKey(for player: GKLocalPlayer) -> String {
        "gameCenter.reported." + player.gamePlayerID
    }

    private static func reported(_ key: String) -> [String: Int] {
        UserDefaults.standard.dictionary(forKey: key) as? [String: Int] ?? [:]
    }

    private func flush() {
        guard isSignedIn, postsScores, !isReporting, !pending.isEmpty else { return }
        let player = GKLocalPlayer.local
        let key = Self.reportedKey(for: player)
        let due = Self.due(pending, reported: Self.reported(key))
        pending = [:]
        guard !due.isEmpty else { return }

        isReporting = true
        let generation = self.generation
        Task {
            var sent: [String: Int] = [:]
            var failed: [String: Int] = [:]
            for (leaderboardID, score) in due {
                do {
                    try await GKLeaderboard.submitScore(score, context: 0, player: player,
                                                        leaderboardIDs: [leaderboardID])
                    sent[leaderboardID] = score
                } catch {
                    failed[leaderboardID] = score
                }
            }
            UserDefaults.standard.set(Self.reported(key).merging(sent) { _, new in new }, forKey: key)
            isReporting = false

            // Newer scores that came in meanwhile go now. One that failed
            // (offline) waits for the next dashboard, rather than going round
            // and round.
            let arrived = !pending.isEmpty
            if generation == self.generation {
                pending.merge(failed) { newer, _ in newer }
            }
            if arrived { flush() }
        }
    }
}
