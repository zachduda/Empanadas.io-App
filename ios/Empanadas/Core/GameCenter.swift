// GameKit's types (GKLocalPlayer, which a score is submitted for) are not
// marked Sendable yet.
@preconcurrency import GameKit
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

/// The Spin Game's achievements, under the names the site gives them
/// (givea() in its _spin.js, which also saves them with the game). Each is an
/// achievement in Game Center too, and has to exist in App Store Connect
/// under its gameCenterID (ios/README.md, "Game Center"). One the site adds
/// later is skipped here until it is added to both.
enum SpinAchievement: String, CaseIterable {
    case firstSpin = "first_spin"
    case firstMedal = "first_medal"
    case oneThousand = "one_thousand"
    case tenThousand = "ten_thousand"
    case fiftyThousand = "fifty_thousand"
    case prestigeOne = "prestige_one"
    case prestigeTwo = "prestige_two"
    case prestigeFive = "prestige_five"
    case prestigeTen = "prestige_ten"
    case prestigeTwentyFive = "prestige_twentyfive"
    case prestigeFifty = "prestige_fifty"
    case prestigeHundred = "prestige_hundred"
    case ascendOne = "ascend_one"
    case ascendTwo = "ascend_two"
    case ascendThree = "ascend_three"
    case ascendFour = "ascend_four"
    case ascendFive = "ascend_five"
    case ascendHundred = "ascend_hundred"
    case ascendOneThousand = "ascend_one_thousand"
    case superstarSpinner = "superstar_spinner"
    case firstAutoSpinner = "first_autospinner"
    case firstBurnt = "first_burnt"
    case secondBurnt = "second_burnt"
    case tenBurnt = "ten_burnt"
    case twentyFiveBurnt = "twentyfive_burnt"
    case oneHundredBurnt = "onehundred_burnt"
    case gimmeSpace = "gimme_space"
    case debugNerd = "debug_nerd"
    case buyExtinguisher = "buy_extinguisher"

    /// The achievement's ID in Game Center. Like a leaderboard's, it can
    /// never be changed or reused once made.
    var gameCenterID: String {
        "io.empanadas.app.achievement.spin." + rawValue
    }
}

/// Game Center's leaderboards, next to the site's. The scores are the ones
/// the site keeps, not the games': each fresh dashboard (DashboardModel)
/// brings the player's numbers, and whatever changed since the last report
/// goes to Game Center. So it is the same ranking as the Leaderboard tab, and
/// a best set on the website or the desktop app gets there too.
///
/// The Spin Game's achievements go the same way: the dashboard lists the ones
/// the site has saved, so one earned on the website or the desktop app is
/// unlocked here too, and the game tells the app the moment one is earned in
/// it (window.empanadasApp.achievement, NativeBridge), so Game Center's
/// banner comes up while the player is still playing. Those it already had
/// (the game names them as its save loads) and the dashboard's go quietly.
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
            if postsScores {
                flush()
                flushAchievements()
            }
        }
    }

    @ObservationIgnored private var started = false
    /// The newest score for each leaderboard, until it has been reported.
    @ObservationIgnored private var pending: [String: Int] = [:]
    @ObservationIgnored private var isReporting = false
    /// Achievements to unlock, each with whether to show Game Center's banner
    /// for it, until they have been reported.
    @ObservationIgnored private var pendingAchievements: [String: Bool] = [:]
    @ObservationIgnored private var isReportingAchievements = false
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
        // Sendable, so not taken to be on the main actor: GameKit may call
        // it from another thread, and it goes to the main actor itself.
        GKLocalPlayer.local.authenticateHandler = { @Sendable [weak self] controller, _ in
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
        flushAchievements()
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

    /// A fresh dashboard: its scores go to Game Center if they changed, and
    /// its achievements if they are new there, now or once the player is
    /// signed in there.
    func report(_ dashboard: Dashboard) {
        for game in Game.allCases {
            pending[game.gameCenterLeaderboardID] = dashboard.leaderboardScore(for: game)
        }
        flush()
        // Quietly: these were earned earlier, perhaps somewhere else, and a
        // first dashboard can bring many at once.
        for name in dashboard.spin.achievements {
            guard let achievement = SpinAchievement(rawValue: name) else { continue }
            pendingAchievements[achievement.gameCenterID] = pendingAchievements[achievement.gameCenterID] ?? false
        }
        flushAchievements()
    }

    /// An achievement from the Spin Game (NativeBridge): with Game Center's
    /// banner when just earned, without for one its save already had.
    func unlock(_ achievement: SpinAchievement, banner: Bool) {
        let id = achievement.gameCenterID
        pendingAchievements[id] = banner || pendingAchievements[id] == true
        flushAchievements()
    }

    /// Signed out of the app: the last account's scores and achievements must
    /// not go out later under the next one.
    func reset() {
        generation += 1
        pending = [:]
        pendingAchievements = [:]
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

    /// The achievements already unlocked for this Game Center player, kept
    /// as reportedKey's is, so each is reported once.
    private static func achievedKey(for player: GKLocalPlayer) -> String {
        "gameCenter.achieved." + player.gamePlayerID
    }

    /// Of `achievements`, the ones still to unlock: those not unlocked
    /// already for this player.
    nonisolated static func due(_ achievements: [String: Bool], achieved: Set<String>) -> [String: Bool] {
        achievements.filter { !achieved.contains($0.key) }
    }

    private static func achieved(_ key: String) -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
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

    // MARK: - Achievements

    private func flushAchievements() {
        guard isSignedIn, postsScores, !isReportingAchievements, !pendingAchievements.isEmpty else { return }
        let player = GKLocalPlayer.local
        let key = Self.achievedKey(for: player)
        let due = Self.due(pendingAchievements, achieved: Self.achieved(key))
        pendingAchievements = [:]
        guard !due.isEmpty else { return }

        isReportingAchievements = true
        let generation = self.generation
        Task {
            let unlocked = due.map { entry -> GKAchievement in
                let achievement = GKAchievement(identifier: entry.key, player: player)
                achievement.percentComplete = 100
                achievement.showsCompletionBanner = entry.value
                return achievement
            }
            do {
                // All at once, so a first dashboard's many are one request.
                try await GKAchievement.report(unlocked)
                UserDefaults.standard.set(Array(Self.achieved(key).union(due.keys)).sorted(), forKey: key)
            } catch {
                // Offline, or not in App Store Connect yet: they wait for the
                // next dashboard or unlock, rather than going round and round.
                if generation == self.generation {
                    pendingAchievements.merge(due) { newer, _ in newer }
                }
                isReportingAchievements = false
                return
            }
            isReportingAchievements = false
            // Any earned meanwhile go now.
            flushAchievements()
        }
    }
}
