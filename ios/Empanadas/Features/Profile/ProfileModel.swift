import SwiftUI

/// A native profile screen to push: a player's, or Find Friends. Every tab's
/// navigation stack shows these (profileDestinations()), so a profile can be
/// opened from a profile wherever it is.
enum ProfileRoute: Hashable {
    /// Nil id: the player's own. The name is the title until the profile loads.
    case player(id: String?, name: String?)
    case findFriends
}

extension View {
    /// Lets NavigationLink(value: ProfileRoute) work in this navigation stack.
    func profileDestinations() -> some View {
        navigationDestination(for: ProfileRoute.self) { route in
            switch route {
            case .player(let id, let name): ProfileView(id: id, name: name)
            case .findFriends: FindFriendsView()
            }
        }
    }
}

/// State behind one profile screen: the profile as the site shows it to this
/// player, and the friend buttons and the bio, one change at a time. After a
/// change the profile is read again, so the screen shows what the site now
/// has rather than a guess.
///
/// The player's own profile opens with the copy saved last time
/// (OfflineStore), as the other native screens do; other players' are not
/// kept.
@MainActor
@Observable
final class ProfileModel {
    /// Nil for the player's own.
    let id: String?
    private(set) var profile: PlayerProfile?
    /// When `profile` came from the site.
    private(set) var updatedAt: Date?
    private(set) var isLoading = false
    private(set) var error: AccountError?
    /// The profile id a change is being sent for, or "bio". Buttons wait
    /// while one is: the site takes one at a time.
    private(set) var working: String?
    var actionError: String?
    var needsCaptcha = false
    /// Bumped by every request: only the answer to the newest is shown.
    @ObservationIgnored private var generation = 0

    init(id: String?) {
        self.id = id.flatMap { $0.isEmpty ? nil : $0 }
        if self.id == nil, let saved = OfflineStore.load(PlayerProfile.self, .profile) {
            profile = saved.value
            updatedAt = saved.savedAt
        }
    }

    /// No such player, or one who deactivated their account.
    var isMissing: Bool {
        error == .unavailable("not_found")
    }

    func load(app: AppModel, maxAge: TimeInterval = 0) async {
        if error == nil, let updatedAt, Date().timeIntervalSince(updatedAt) < maxAge { return }
        guard !isLoading else { return }
        await fetch(app: app)
    }

    /// Asks even while a request is under way, whose answer is then dropped.
    /// After a change: a load the screen started as it opened (My Profile
    /// opens with the saved copy, so its buttons work at once) was sent before
    /// the change, and skipping the new one showed the request still waiting.
    private func fetch(app: AppModel) async {
        generation += 1
        let generation = self.generation
        isLoading = true
        defer {
            if generation == self.generation { isLoading = false }
        }
        do {
            let fresh = try await app.account.profile(id: id)
            guard generation == self.generation, app.session == .signedIn else { return }
            profile = fresh
            updatedAt = Date()
            error = nil
        } catch let failure as AccountError {
            guard generation == self.generation else { return }
            if failure == .signedOut { app.observe(.unsure) }
            error = failure
        } catch {
            guard generation == self.generation else { return }
            self.error = .network
        }
    }

    // MARK: - Friends

    func addFriend(_ playerID: String, app: AppModel) async {
        await perform(playerID, app: app, haptic: "success") {
            try await app.account.addFriend(playerID)
        }
    }

    func answer(_ playerID: String, accept: Bool, app: AppModel) async {
        await perform(playerID, app: app, haptic: accept ? "success" : "light") {
            try await app.account.answerFriendRequest(from: playerID, accept: accept)
        }
    }

    /// Unfriends, or takes back a request.
    func remove(_ playerID: String, app: AppModel) async {
        await perform(playerID, app: app, haptic: "light") {
            try await app.account.removeFriend(playerID)
        }
    }

    /// Returns true when the site took it.
    func saveBio(_ text: String, app: AppModel) async -> Bool {
        await perform("bio", app: app, haptic: "success") {
            try await app.account.updateBio(text)
        }
    }

    @discardableResult
    private func perform(_ key: String, app: AppModel, haptic: String,
                         _ change: () async throws -> Void) async -> Bool {
        guard working == nil else { return false }
        working = key
        defer { working = nil }
        do {
            try await change()
            Haptics.play(haptic)
            app.friendsChanged()
            await fetch(app: app)
            return true
        } catch {
            report(error, app: app)
            return false
        }
    }

    private func report(_ error: Error, app: AppModel) {
        Haptics.play("error")
        switch error as? AccountError {
        case .signedOut?:
            app.observe(.unsure)
        case .needsCaptcha?:
            needsCaptcha = true
        case let error?:
            actionError = error.localizedDescription
        case nil:
            actionError = AccountError.network.localizedDescription
        }
    }
}
