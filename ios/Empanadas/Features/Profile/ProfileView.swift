import SwiftUI

/// A player's profile, native: what the site's /v2/profile/<id> shows this
/// player, read from /v2/ios/profile.php (ProfileModel). The player's own
/// (My Profile) also answers friend requests, lets friends go and edits the
/// status line; anyone else's has the Add Friend button.
struct ProfileView: View {
    @Environment(AppModel.self) private var model
    @State private var profile: ProfileModel
    /// The title until the profile has loaded.
    let name: String?

    @State private var editingBio = false
    @State private var removing: Removal?

    init(id: String?, name: String? = nil) {
        _profile = State(initialValue: ProfileModel(id: id))
        self.name = name
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let data = profile.profile {
                    OfflineNotice(isOnline: model.isOnline, updatedAt: profile.updatedAt,
                                  refreshFailed: profile.error != nil && profile.error != .signedOut) {
                        Task { await profile.load(app: model) }
                    }
                    ProfileContent(data: data, profile: profile,
                                   editBio: { editingBio = true },
                                   remove: { removing = $0 })
                        // A change has to reach the site to count.
                        .disabled(!model.isOnline)
                } else if profile.isMissing {
                    missing
                } else if let error = profile.error, !profile.isLoading {
                    loadFailed(error)
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .frame(maxWidth: .infinity, minHeight: 320)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
            .readableWidth(ReadableWidth.wide)
            .animation(.smooth, value: profile.profile)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .refreshable { await profile.load(app: model) }
        // Each time it comes back on screen (from a profile picture change,
        // a friend's profile), unless it is fresh.
        .task { await profile.load(app: model, maxAge: 15) }
        .onChange(of: model.isOnline) { _, online in
            if online { Task { await profile.load(app: model) } }
        }
        .navigationDestination(isPresented: $profile.needsCaptcha) {
            WebDestination(url: SiteURLs.page("/v2/captcha"), title: "Quick Check")
        }
        .alert("Couldn't Do That", isPresented: Binding(
            // The status editor shows its own while it is up.
            get: { profile.actionError != nil && !editingBio },
            set: { if !$0 { profile.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(profile.actionError ?? "")
        }
        .confirmationDialog(removing?.question ?? "", isPresented: Binding(
            get: { removing != nil },
            set: { if !$0 { removing = nil } }
        ), titleVisibility: .visible, presenting: removing) { target in
            Button(target.action, role: .destructive) {
                Task { await profile.remove(target.playerID, app: model) }
            }
        } message: { target in
            Text(target.detail)
        }
        .sheet(isPresented: $editingBio) {
            BioEditor(profile: profile, current: profile.profile?.player.bio)
                .presentationDetents([.medium, .large])
        }
    }

    private var title: String {
        if let player = profile.profile?.player {
            return player.isSelf ? "My Profile" : player.username
        }
        if profile.id == nil { return "My Profile" }
        return name ?? "Profile"
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if let data = profile.profile {
            if data.isSelf {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: ProfileRoute.findFriends) {
                        Image(systemName: "person.badge.plus")
                    }
                    .accessibilityLabel("Find Friends")
                }
            }
            if let url = data.webURL {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share Profile")
                }
            }
        }
    }

    private var missing: some View {
        ContentUnavailableView {
            Label("Poof! They're Gone.", systemImage: "person.crop.circle.badge.questionmark")
        } description: {
            Text("This player couldn't be found. Their account may have been deactivated.")
        } actions: {
            NavigationLink(value: ProfileRoute.findFriends) {
                Text("Find Friends")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.top, 60)
    }

    private func loadFailed(_ error: AccountError) -> some View {
        ContentUnavailableView {
            Label(model.isOnline ? "Couldn't Load This Profile" : "You're Offline",
                  systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
        } description: {
            Text(model.isOnline ? error.localizedDescription : "Profiles show up here once you're back online.")
        } actions: {
            if model.isOnline {
                Button("Try Again") { Task { await profile.load(app: model) } }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.top, 60)
    }
}

/// A friend to let go, or a request to take back, waiting on the player to
/// confirm.
struct Removal: Identifiable {
    let playerID: String
    let username: String
    /// A request rather than a friendship.
    let isRequest: Bool

    var id: String { playerID }

    var question: String {
        isRequest ? "Cancel your friend request to \(username)?" : "Unfriend \(username)?"
    }

    var action: String {
        isRequest ? "Cancel Request" : "Unfriend"
    }

    /// The web's words (pendingFriend() in profile.js).
    var detail: String {
        isRequest
            ? "You can send another one later."
            : "You'll no longer be able to see parts of their profile. They won't be notified. This can't be undone."
    }
}

// MARK: - Content

/// Everything under the offline notice, in the site's order.
private struct ProfileContent: View {
    let data: PlayerProfile
    let profile: ProfileModel
    let editBio: () -> Void
    let remove: (Removal) -> Void

    var body: some View {
        VStack(spacing: 16) {
            ProfileHero(data: data, editBio: editBio)

            if !data.isSelf {
                RelationshipCard(data: data, profile: profile, remove: remove)
            }

            MasonryColumns(minColumnWidth: 340) {
                if let friends = data.friends {
                    ProfileFriendsCard(data: data, friends: friends, profile: profile, remove: remove)
                }
                if let xp = data.xp {
                    ProfileExperienceCard(xp: xp, days: data.player.days)
                }
                if data.player.isPrivate {
                    PrivateCard(data: data)
                } else if let stats = data.stats {
                    ProfileStatsCard(stats: stats, username: data.player.username, isSelf: data.isSelf)
                }
                if let sign = data.player.starSign {
                    StarSignCard(sign: sign)
                }
            }
        }
    }
}

private struct ProfileHero: View {
    let data: PlayerProfile
    let editBio: () -> Void

    private var player: PlayerProfile.Player { data.player }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 16) {
                picture

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(player.username)
                            .font(.title2.bold())
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        if player.admin {
                            Image(systemName: "crown.fill")
                                .foregroundStyle(.orange)
                                .accessibilityLabel("Administrator")
                        }
                        if player.supporter {
                            Image(systemName: "heart.fill")
                                .foregroundStyle(Color(hex: 0xFA8072))
                                .accessibilityLabel("Supporter")
                        }
                    }
                    meta
                }
            }

            bio
        }
        .foregroundStyle(.white)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Color("Brand"), Color(hex: 0x4A5BF0)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
    }

    @ViewBuilder
    private var picture: some View {
        let avatar = Avatar(url: player.pictureURL, size: 84)
            .overlay(Circle().stroke(.white.opacity(0.7), lineWidth: 2))
        if data.isSelf {
            NavigationLink {
                WebDestination(url: SiteURLs.profilePicture, title: "Profile Picture")
            } label: {
                avatar
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "camera.fill")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color("Brand"))
                            .frame(width: 24, height: 24)
                            .background(.white, in: Circle())
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Change profile picture")
        } else {
            avatar
        }
    }

    @ViewBuilder
    private var meta: some View {
        if player.isPrivate {
            Label("Private profile", systemImage: "lock.fill")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.black.opacity(0.25), in: Capsule())
        } else {
            HStack(spacing: 8) {
                if let month = player.memberSinceMonth {
                    Text("Member since \(month)")
                        .font(.subheadline)
                        .opacity(0.85)
                }
                if let presence = player.presence {
                    PresencePill(presence: presence)
                }
            }
        }
    }

    @ViewBuilder
    private var bio: some View {
        if data.isSelf {
            if player.emailVerified == false {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Verify your email to set a status.")
                        .font(.subheadline)
                        .opacity(0.85)
                    NavigationLink {
                        WebDestination(url: SiteURLs.verifyEmail, title: "Verify Email")
                    } label: {
                        Label("Verify Email", systemImage: "envelope.fill")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.white.opacity(0.18), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 4)
            } else {
                Button(action: editBio) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let text = player.bio {
                            Text(text)
                                .multilineTextAlignment(.leading)
                        } else {
                            Text("Set your status…").opacity(0.7)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "pencil")
                            .font(.subheadline.weight(.semibold))
                            .opacity(0.7)
                    }
                    .font(.subheadline)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(player.bio.map { "Status: \($0)" } ?? "Set your status")
                .accessibilityHint("Edits your status")
            }
        } else if let text = player.bio {
            Text(text)
                .font(.subheadline)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else if player.isPrivate {
            Text("Only \(player.username)'s friends can see the rest of this profile.")
                .font(.subheadline)
                .opacity(0.85)
        }
    }
}

private struct PresencePill: View {
    let presence: PlayerProfile.Presence

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(PresenceDot.color(presence.state))
                .frame(width: 8, height: 8)
            Text(presence.label.isEmpty ? presence.state.capitalized : presence.label)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.25), in: Capsule())
    }
}

enum PresenceDot {
    static func color(_ state: String?) -> Color {
        switch state {
        case "online": Palette.online
        case "idle": Palette.idle
        default: Color.gray.opacity(0.6)
        }
    }
}

/// Add Friend, the request either way, or the friendship, for someone else's
/// profile.
private struct RelationshipCard: View {
    @Environment(AppModel.self) private var model
    let data: PlayerProfile
    let profile: ProfileModel
    let remove: (Removal) -> Void

    private var player: PlayerProfile.Player { data.player }
    private var working: Bool { profile.working == player.id }

    var body: some View {
        Card(title, systemImage: icon, tint: tint) {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            buttons
                .disabled(profile.working != nil)
        }
    }

    private var title: String {
        switch data.relationship {
        case .friends: "Friends"
        case .incoming: "Friend Request"
        case .outgoing: "Request Sent"
        case .me, .stranger: data.acceptsRequests ? "Add Friend" : "Become Friends"
        }
    }

    private var icon: String {
        switch data.relationship {
        case .friends: "person.2.fill"
        case .incoming: "person.badge.plus"
        case .outgoing: "paperplane.fill"
        case .me, .stranger: data.acceptsRequests ? "person.badge.plus" : "lock.fill"
        }
    }

    private var tint: Color {
        data.relationship == .stranger && !data.acceptsRequests ? .secondary : Palette.friends
    }

    /// profile.php's words for each case.
    private var message: String {
        let name = player.username
        switch data.relationship {
        case .friends:
            return "You and \(name) are friends."
        case .incoming:
            return "\(name) wants to be your friend."
        case .outgoing:
            return player.isPrivate
                ? "You'll be able to see \(name)'s profile once they accept your friend request."
                : "Waiting on \(name) to accept your friend request."
        case .me, .stranger:
            if !data.acceptsRequests {
                return "It looks like \(name) has turned off new friend requests for now. Bummer!"
            }
            return player.isPrivate
                ? "You aren't able to view \(name)'s profile until you're friends."
                : "Become friends to see when \(name) is online."
        }
    }

    @ViewBuilder
    private var buttons: some View {
        switch data.relationship {
        case .friends:
            Button(role: .destructive) {
                remove(Removal(playerID: player.id, username: player.username, isRequest: false))
            } label: {
                label("Unfriend", systemImage: "person.badge.minus")
            }
            .buttonStyle(.bordered)
        case .incoming:
            HStack(spacing: 10) {
                Button {
                    Task { await profile.answer(player.id, accept: true, app: model) }
                } label: {
                    label("Accept", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.flappy)
                Button(role: .destructive) {
                    Task { await profile.answer(player.id, accept: false, app: model) }
                } label: {
                    label("Decline", systemImage: "xmark")
                }
                .buttonStyle(.bordered)
            }
        case .outgoing:
            Button {
                remove(Removal(playerID: player.id, username: player.username, isRequest: true))
            } label: {
                label("Cancel Request", systemImage: "xmark")
            }
            .buttonStyle(.bordered)
        case .me, .stranger:
            if data.acceptsRequests {
                Button {
                    Task { await profile.addFriend(player.id, app: model) }
                } label: {
                    label("Add Friend", systemImage: "plus.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.flappy)
            }
        }
    }

    private func label(_ title: String, systemImage: String) -> some View {
        HStack {
            if working {
                ProgressView()
            } else {
                Label(title, systemImage: systemImage)
            }
        }
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
}

private struct PrivateCard: View {
    let data: PlayerProfile

    var body: some View {
        Card("Stats", systemImage: "lock.fill", tint: .secondary) {
            Text(data.relationship == .outgoing
                 ? "You'll be able to see \(data.player.username)'s stats once your friend request gets approved."
                 : "Add \(data.player.username) as a friend to view their stats!")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.vertical, 12)
        }
    }
}

/// Friends, and on the player's own profile the requests both ways.
private struct ProfileFriendsCard: View {
    @Environment(AppModel.self) private var model
    let data: PlayerProfile
    let friends: PlayerProfile.Friends
    let profile: ProfileModel
    let remove: (Removal) -> Void

    private var aside: String {
        "\(friends.total.formatted()) friend\(friends.total == 1 ? "" : "s")"
    }

    var body: some View {
        Card(data.isSelf ? "Your Friends" : "\(data.player.username)'s Friends",
             systemImage: "person.2.fill", tint: Palette.friends, aside: aside) {
            if data.isSelf && !friends.incoming.isEmpty {
                group("Requests") {
                    ForEach(friends.incoming) { row($0) }
                }
            }
            if data.isSelf && !friends.outgoing.isEmpty {
                group("Sent") {
                    ForEach(friends.outgoing) { row($0) }
                }
            }

            if friends.accepted.isEmpty {
                VStack(spacing: 10) {
                    Text("Nobody is here, yet! 😭")
                        .foregroundStyle(.secondary)
                    if data.isSelf {
                        NavigationLink(value: ProfileRoute.findFriends) {
                            Label("Find People", systemImage: "magnifyingglass")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Palette.friends)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else {
                group(data.isSelf && friends.list.count > friends.accepted.count ? "Friends" : nil) {
                    ForEach(friends.accepted) { row($0) }
                }
            }

            if friends.total > friends.accepted.count {
                Text("Showing \(friends.accepted.count.formatted()) of \(friends.total.formatted()).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func group<Content: View>(_ title: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let title {
                Text(title.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            }
            content()
        }
    }

    private func row(_ friend: PlayerProfile.Friend) -> some View {
        HStack(spacing: 10) {
            NavigationLink(value: ProfileRoute.player(id: friend.playerID, name: friend.username)) {
                FriendIdentity(friend: friend)
            }
            .buttonStyle(.plain)
            .disabled(friend.playerID.isEmpty)

            if data.isSelf {
                actions(friend)
                    .disabled(profile.working != nil)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func actions(_ friend: PlayerProfile.Friend) -> some View {
        if profile.working == friend.playerID {
            ProgressView()
        } else {
            switch friend.relation {
            case .incoming:
                HStack(spacing: 6) {
                    Button {
                        Task { await profile.answer(friend.playerID, accept: true, app: model) }
                    } label: {
                        Image(systemName: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.flappy)
                    .accessibilityLabel("Accept \(friend.username)")
                    Button(role: .destructive) {
                        Task { await profile.answer(friend.playerID, accept: false, app: model) }
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Decline \(friend.username)")
                }
                .controlSize(.small)
            case .outgoing:
                Button {
                    remove(Removal(playerID: friend.playerID, username: friend.username, isRequest: true))
                } label: {
                    Text("Cancel")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            case .friends, .me, .stranger:
                Menu {
                    Button(role: .destructive) {
                        remove(Removal(playerID: friend.playerID, username: friend.username, isRequest: false))
                    } label: {
                        Label("Unfriend", systemImage: "person.badge.minus")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More for \(friend.username)")
            }
        }
    }
}

/// A friend's picture, name and how they're doing: a profile row.
private struct FriendIdentity: View {
    let friend: PlayerProfile.Friend

    private var detail: String? {
        switch friend.relation {
        case .incoming: return "Wants to be friends"
        case .outgoing: return "Request sent"
        default: return friend.label
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: friend.pictureURL, size: 38)
                .overlay(alignment: .bottomTrailing) {
                    if friend.state != nil {
                        Circle()
                            .fill(PresenceDot.color(friend.state))
                            .frame(width: 11, height: 11)
                            .overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
                    }
                }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(friend.username)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if friend.isYou {
                        Text("You")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Palette.friends, in: Capsule())
                    }
                }
                if let detail, !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct ProfileExperienceCard: View {
    let xp: PlayerProfile.Experience
    let days: Int?

    @State private var showsBreakdown = false

    var body: some View {
        Card("Experience", systemImage: "star.fill", tint: Palette.experience, aside: "\(xp.total.formatted()) XP") {
            HStack(spacing: 8) {
                Text(xp.icon)
                Text(xp.rank).fontWeight(.semibold)
                if !xp.range.isEmpty {
                    Text(xp.range)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.primary.opacity(0.08), in: Capsule())
                }
            }
            .font(.title3)

            Meter(value: xp.progress, tint: Palette.experience)

            HStack {
                if let next = xp.next, let nextRank = xp.nextRank {
                    Text("\(max(0, next - xp.total).formatted()) XP to \(nextRank)")
                } else {
                    Text("Top rank reached")
                }
                Spacer()
                if let days {
                    Text("Member for \(days.formatted()) day\(days == 1 ? "" : "s")")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if xp.breakdown.isEmpty {
                Text("No XP earned yet. Play games to earn XP!")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                DisclosureGroup("What Earned It", isExpanded: $showsBreakdown) {
                    VStack(spacing: 6) {
                        ForEach(xp.breakdown) { part in
                            HStack {
                                Text(part.label)
                                Spacer()
                                Text("\(part.xp.formatted()) XP")
                                    .fontWeight(.semibold)
                                    .monospacedDigit()
                                Text("\(part.percent)%")
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                                    .frame(minWidth: 40, alignment: .trailing)
                            }
                            .font(.subheadline)
                        }
                    }
                    .padding(.top, 8)
                }
                .font(.subheadline.weight(.semibold))
                .tint(Palette.experience)
            }
        }
    }
}

private struct ProfileStatsCard: View {
    let stats: PlayerProfile.Stats
    let username: String
    let isSelf: Bool

    private struct Row: Identifiable {
        let label: String
        let value: Int
        var id: String { label }
    }

    var body: some View {
        Card("Stats", systemImage: "trophy.fill", tint: Color(hex: 0xFF9D47)) {
            if !stats.hasPlayed && stats.peppers.lifetime == 0 {
                Text(isSelf ? "You haven't played any games, yet!" : "\(username) hasn't played any games, yet!")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                game(.spin, stats.spin.map {
                    [Row(label: "Lifetime manual spins", value: $0.lifetime),
                     Row(label: "Current spins", value: $0.current),
                     Row(label: "Ascensions", value: $0.ascends),
                     Row(label: "Prestige", value: $0.prestige)]
                })
                game(.flappy, stats.flappy.map {
                    [Row(label: "Highest score", value: $0.high),
                     Row(label: "Rounds played", value: $0.played),
                     Row(label: "Most recent", value: $0.recent)]
                })
                game(.tower, stats.tower.map {
                    [Row(label: "Tallest tower", value: $0.high),
                     Row(label: "Runs played", value: $0.played),
                     Row(label: "Most recent", value: $0.recent),
                     Row(label: "Best perfect streak", value: $0.bestStreak ?? 0),
                     Row(label: "Perfect drops", value: $0.perfects ?? 0)]
                })
                section("Peppers", systemImage: "flame.fill", tint: Palette.peppers, rows: [
                    Row(label: "Current peppers", value: stats.peppers.current),
                    Row(label: "Lifetime peppers", value: stats.peppers.lifetime),
                ])
                if stats.pumpkinSeason {
                    section("Halloween", systemImage: "leaf.fill", tint: Palette.pumpkin, rows: [
                        Row(label: "Pumpkins collected", value: stats.pumpkins),
                    ])
                }
            }
        }
    }

    @ViewBuilder
    private func game(_ game: Game, _ rows: [Row]?) -> some View {
        if let rows {
            section(game.title, systemImage: game.systemImage, tint: game.tint, rows: rows)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                heading(game.title, systemImage: game.systemImage, tint: game.tint)
                Text("No \(game.title) progress yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func section(_ title: String, systemImage: String, tint: Color, rows: [Row]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            heading(title, systemImage: systemImage, tint: tint)
            ForEach(rows) { row in
                HStack {
                    Text(row.label).foregroundStyle(.secondary)
                    Spacer()
                    Text(row.value, format: .number)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                }
                .font(.subheadline)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func heading(_ title: String, systemImage: String, tint: Color) -> some View {
        Label {
            Text(title.uppercased())
        } icon: {
            Image(systemName: systemImage).foregroundStyle(tint)
        }
        .font(.caption.weight(.bold))
        .foregroundStyle(.secondary)
        .padding(.top, 4)
    }
}

private struct StarSignCard: View {
    let sign: PlayerProfile.StarSign

    var body: some View {
        Card {
            HStack(alignment: .top, spacing: 12) {
                Text(sign.symbol.isEmpty ? "✨" : sign.symbol)
                    .font(.title)
                    .frame(width: 44, height: 44)
                    .background(Palette.friends.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(sign.name).font(.headline)
                    if !sign.blurb.isEmpty {
                        Text(sign.blurb)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

// MARK: - Status editor

/// The status line under the player's name (the site's "bio"): one line, at
/// most 200 characters, saved through account_change=bio.
private struct BioEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let profile: ProfileModel

    @State private var text: String
    @FocusState private var focused: Bool

    /// The site's limit, which it counts in characters as PHP's mb_strlen
    /// does: Unicode scalars, not what Swift counts as a character.
    static let limit = 200

    init(profile: ProfileModel, current: String?) {
        self.profile = profile
        _text = State(initialValue: current ?? "")
    }

    private var saving: Bool { profile.working == "bio" }
    private var length: Int { AccountAPI.bioLine(text).unicodeScalars.count }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Type a cool status…", text: $text, axis: .vertical)
                        .lineLimit(3...6)
                        .focused($focused)
                        .submitLabel(.done)
                        // A status is one line. A field that wraps takes
                        // Return as a newline rather than a submit, so a
                        // Return typed at the end saves, and newlines pasted
                        // in come out.
                        .onChange(of: text) { old, new in
                            guard new.contains(where: \.isNewline) else { return }
                            text = new.filter { !$0.isNewline }
                            if new == old + "\n" { save() }
                        }
                } footer: {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Shown on your profile, under your name.")
                        Spacer()
                        Text("\(length)/\(Self.limit)")
                            .monospacedDigit()
                            .foregroundStyle(length > Self.limit ? Color.red : Color.secondary)
                    }
                }
            }
            .navigationTitle("Status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save", action: save)
                            .disabled(length > Self.limit || !model.isOnline)
                    }
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear { focused = true }
            .alert("Couldn't Save", isPresented: Binding(
                get: { profile.actionError != nil },
                set: { if !$0 { profile.actionError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(profile.actionError ?? "")
            }
        }
    }

    private func save() {
        guard !saving, length <= Self.limit else { return }
        Task {
            if await profile.saveBio(text, app: model) {
                dismiss()
            }
        }
    }
}
