import SwiftUI

/// The dashboard, native: what the site's /v2/dashboard shows, read from
/// /v2/ios/dashboard.php (DashboardModel). The parts that are still the web's
/// (profiles, friend search, the profile picture) open as pages pushed on top.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    @State private var destination: WebLink?

    var body: some View {
        let dashboard = model.dashboard

        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    OfflineNotice(isOnline: model.isOnline,
                                  updatedAt: dashboard.data == nil ? nil : dashboard.updatedAt,
                                  refreshFailed: dashboard.data != nil && dashboard.error != nil) {
                        Task { await dashboard.load(app: model) }
                    }

                    if let data = dashboard.data {
                        DashboardContent(data: data, open: { destination = $0 })
                    } else if let error = dashboard.error, !dashboard.isLoading {
                        loadFailed(error)
                    } else {
                        ProgressView()
                            .controlSize(.large)
                            .frame(maxWidth: .infinity, minHeight: 320)
                    }
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
                .animation(.smooth, value: model.isOnline)
                .animation(.smooth, value: dashboard.data == nil)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Home")
            .glassNavigationBar()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    accountMenu(dashboard.data)
                }
            }
            .navigationDestination(item: $destination) { link in
                WebDestination(url: link.url, title: link.title, interceptsRoutes: true)
            }
            .refreshable { await dashboard.load(app: model) }
            .task(id: scenePhase) { await keepFresh() }
            .onChange(of: model.isOnline) { _, online in
                if online { Task { await dashboard.load(app: model) } }
            }
        }
    }

    /// While the tab is on screen and the app in front: a refresh if the last
    /// is a little old, then one a minute, as the site's dashboard refreshes
    /// its friends list.
    private func keepFresh() async {
        guard scenePhase == .active else { return }
        await model.dashboard.load(app: model, maxAge: 20)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            if model.isOnline { await model.dashboard.load(app: model) }
        }
    }

    private func accountMenu(_ data: Dashboard?) -> some View {
        Menu {
            Button { destination = .profile } label: { Label("My Profile", systemImage: "person.crop.circle") }
            Button { destination = .findFriends } label: { Label("Find Friends", systemImage: "magnifyingglass") }
            Button { model.navigate(to: .leaderboard) } label: { Label("Leaderboards", systemImage: "trophy") }
            Button { model.navigate(to: .settings) } label: { Label("Settings", systemImage: "gearshape") }
        } label: {
            Avatar(url: data?.pictureURL, size: 30)
        }
        .accessibilityLabel("Account")
    }

    private func loadFailed(_ error: AccountError) -> some View {
        ContentUnavailableView {
            Label(model.isOnline ? "Couldn't Load Your Dashboard" : "You're Offline",
                  systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
        } description: {
            Text(model.isOnline
                 ? error.localizedDescription
                 : "Your dashboard shows up here once you're back online. Games you've played before still work offline.")
        } actions: {
            if model.isOnline {
                Button("Try Again") { Task { await model.dashboard.load(app: model) } }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("Play a Game") { model.selectedTab = .games }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.top, 60)
    }
}

/// Everything below the offline notice, in the site dashboard's order.
private struct DashboardContent: View {
    @Environment(AppModel.self) private var model
    let data: Dashboard
    let open: (WebLink) -> Void

    private let tileColumns = [GridItem(.adaptive(minimum: 150), spacing: 12)]
    private let cardColumns = [GridItem(.adaptive(minimum: 320), spacing: 16, alignment: .top)]

    var body: some View {
        VStack(spacing: 16) {
            HeroCard(account: data.account, pictureURL: data.pictureURL, open: open)

            nudge

            LazyVGrid(columns: tileColumns, spacing: 12) {
                StatTile(title: "Peppers", value: data.peppers, systemImage: "flame.fill", tint: Palette.peppers)
                StatTile(title: "Lifetime Spins", value: data.spin.lifetime,
                         systemImage: Game.spin.systemImage, tint: Palette.spin)
                StatTile(title: "Flappy Best", value: data.flappy.high,
                         systemImage: Game.flappy.systemImage, tint: Palette.flappy)
                StatTile(title: "Tower Best", value: data.tower.high,
                         systemImage: Game.tower.systemImage, tint: Palette.tower)
                Button { open(.profile) } label: {
                    StatTile(title: "Friends Online", value: data.friends.online,
                             suffix: "/\(data.friends.total.formatted())",
                             systemImage: "person.2.fill", tint: Palette.friends)
                }
                .buttonStyle(.plain)
                if data.pumpkinSeason {
                    StatTile(title: "Pumpkins", value: data.pumpkins, systemImage: "leaf.fill", emoji: "🎃",
                             tint: Palette.pumpkin)
                }
            }

            LazyVGrid(columns: cardColumns, spacing: 16) {
                ForEach(Game.allCases) { game in
                    GameStatsCard(game: game, data: data) {
                        Haptics.play("light")
                        model.navigate(to: .game(game))
                    }
                }
            }

            LazyVGrid(columns: cardColumns, spacing: 16) {
                SpinChartCard(history: data.spinHistory)
                FriendsCard(friends: data.friends, open: open)
                ExperienceCard(xp: data.xp, open: open)
                if data.pumpkinSeason {
                    PumpkinCard(pumpkins: data.pumpkins)
                }
                PeppersCard(peppers: data.peppers)
            }
        }
    }

    /// The hero's "Almost there!" box: verify the address first, then add a
    /// picture, as on the site.
    @ViewBuilder
    private var nudge: some View {
        if !data.account.emailVerified {
            NudgeCard(title: "Almost there!",
                      message: "Verify your email to secure the account and unlock everything.",
                      button: "Verify Email", systemImage: "envelope.fill") { open(.verifyEmail) }
        } else if !data.account.hasCustomPfp {
            NudgeCard(title: "Make it yours.",
                      message: "Add a profile picture so your friends know it's you.",
                      button: "Upload Picture", systemImage: "photo.fill") { open(.profilePicture) }
        }
    }
}

// MARK: - Cards

private struct HeroCard: View {
    let account: Dashboard.Account
    let pictureURL: URL?
    let open: (WebLink) -> Void

    private var subtitle: String {
        switch account.days {
        case ..<1: "Welcome to your very own Empanadas.io account!"
        case 1: "You've been an Empanada for 1 day."
        default: "You've been an Empanada for \(account.days.formatted()) days."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                Button { open(.profilePicture) } label: {
                    Avatar(url: pictureURL, size: 72)
                        .overlay(Circle().stroke(.white.opacity(0.7), lineWidth: 2))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Change profile picture")

                VStack(alignment: .leading, spacing: 4) {
                    Text("Hey \(account.username) 👋")
                        .font(.title2.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(subtitle)
                        .font(.subheadline)
                        .opacity(0.85)
                }
            }

            HStack(spacing: 10) {
                heroButton("My Profile", systemImage: "person.crop.circle") { open(.profile) }
                heroButton("Find Friends", systemImage: "magnifyingglass") { open(.findFriends) }
            }
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

    private func heroButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.white.opacity(0.18), in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct NudgeCard: View {
    let title: String
    let message: String
    let button: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Card {
            (Text(title).bold() + Text(" ") + Text(message))
                .font(.subheadline)
            Button(action: action) {
                Label(button, systemImage: systemImage)
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
        }
    }
}

private struct GameStatsCard: View {
    let game: Game
    let data: Dashboard
    let play: () -> Void

    private struct Row: Identifiable {
        let label: String
        let value: Int
        var id: String { label }
    }

    private var rows: [Row] {
        switch game {
        case .spin:
            [Row(label: "Manual spins", value: data.spin.lifetime),
             Row(label: "Prestige", value: data.spin.prestige),
             Row(label: "Ascensions", value: data.spin.ascends)]
        case .flappy:
            [Row(label: "Highest score", value: data.flappy.high),
             Row(label: "Most recent", value: data.flappy.recent),
             Row(label: "Rounds played", value: data.flappy.played)]
        case .tower:
            [Row(label: "Tallest tower", value: data.tower.high),
             Row(label: "Most recent", value: data.tower.recent),
             Row(label: "Runs played", value: data.tower.played)]
        }
    }

    private var progress: Double {
        data.score(for: game)?.progress ?? data.spin.progress
    }

    private var meterLabel: String {
        switch game {
        case .spin: "Prestige \(data.spin.prestige.formatted()) of 100"
        case .flappy: "Last round vs. your best"
        case .tower: "Last tower vs. your best"
        }
    }

    private var meterValue: String {
        switch game {
        case .spin: "\(progress.formatted(.number.precision(.fractionLength(1))))% to Ascension"
        case .flappy, .tower: "\(Int(progress.rounded()))%"
        }
    }

    var body: some View {
        Button(action: play) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label {
                        Text(game.title).font(.headline)
                    } icon: {
                        Image(systemName: game.systemImage).foregroundStyle(game.tint)
                    }
                    Spacer()
                    HStack(spacing: 4) {
                        Text("Play")
                        Image(systemName: "chevron.right").font(.caption.weight(.bold))
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(game.tint)
                }

                VStack(spacing: 6) {
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

                Meter(value: progress, tint: game.tint)

                HStack {
                    Text(meterLabel)
                    Spacer()
                    Text(meterValue).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Plays \(game.title)")
    }
}

private struct FriendsCard: View {
    let friends: Dashboard.Friends
    let open: (WebLink) -> Void

    private var requestsWaiting: String {
        friends.pending == 1 ? " friend request waiting" : " friend requests waiting"
    }

    var body: some View {
        Card("Friends", systemImage: "person.2.fill", tint: Palette.friends,
             aside: "\(friends.online.formatted()) online") {
            if friends.pending > 0 {
                Button { open(.profile) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "person.badge.plus")
                        (Text(friends.pending.formatted()).bold() + Text(requestsWaiting))
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.bold))
                    }
                    .font(.subheadline)
                    .foregroundStyle(Palette.friends)
                    .padding(12)
                    .background(Palette.friends.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            }

            if friends.list.isEmpty {
                VStack(spacing: 10) {
                    Text("No friends here yet! 😭")
                        .foregroundStyle(.secondary)
                    Button { open(.findFriends) } label: {
                        Label("Find People", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.friends)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else {
                VStack(spacing: 4) {
                    ForEach(friends.list) { friend in
                        Button { open(.player(friend.uuid, name: friend.username)) } label: {
                            FriendRow(friend: friend)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if friends.total > friends.list.count {
                Button { open(.profile) } label: {
                    Text("See all \(friends.total.formatted()) friends").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
    }
}

private struct FriendRow: View {
    let friend: Dashboard.Friend

    private var dot: Color {
        switch friend.state {
        case "online": Palette.online
        case "idle": Palette.idle
        default: Color.gray.opacity(0.6)
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: SiteURLs.resolve(friend.pfp), size: 38)
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(dot)
                        .frame(width: 11, height: 11)
                        .overlay(Circle().stroke(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(friend.username).font(.subheadline.weight(.semibold))
                Text(friend.label).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct ExperienceCard: View {
    let xp: Dashboard.Experience
    let open: (WebLink) -> Void

    var body: some View {
        Card("Experience", systemImage: "star.fill", tint: Palette.experience, aside: "\(xp.total.formatted()) XP") {
            HStack(spacing: 8) {
                Text(xp.icon)
                Text(xp.rank).fontWeight(.semibold)
            }
            .font(.title3)

            Meter(value: xp.progress, tint: Palette.experience)

            HStack {
                if let next = xp.next, let nextRank = xp.nextRank {
                    Text("\(max(0, next - xp.total).formatted()) XP to \(nextRank)")
                    Spacer()
                    Text("\(Int(xp.progress.rounded()))%")
                } else {
                    Text("Top rank reached")
                    Spacer()
                    Text("100%")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Button { open(.profile) } label: {
                Text("View Breakdown").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
    }
}

private struct PumpkinCard: View {
    let pumpkins: Int

    var body: some View {
        Card {
            VStack(spacing: 6) {
                Text("🎃 Pumpkin Season").font(.headline)
                Text(pumpkins, format: .number)
                    .font(.system(size: 44, weight: .heavy, design: .rounded))
                    .foregroundStyle(Palette.pumpkin)
                Text("Pumpkins Collected").font(.caption).foregroundStyle(.secondary)
                Text("Sometimes a pumpkin appears around the site. Tap it quickly and earn even more!")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct PeppersCard: View {
    let peppers: Int

    var body: some View {
        Card {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "flame.fill")
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Palette.peppers.gradient, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("You have \(peppers.formatted()) peppers").fontWeight(.semibold)
                    Text("As you play games you'll earn peppers. Spend them in the games to unlock neat features.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
