import SwiftUI

/// What the Home tab pushes for the site's announcements: the feed, or one
/// post (a link to /updates?post=<id>).
enum UpdatesRoute: Hashable {
    case all
    case post(String)
}

extension View {
    /// Lets the Updates screens be pushed in this navigation stack.
    func updatesDestinations() -> some View {
        navigationDestination(for: UpdatesRoute.self) { route in
            switch route {
            case .all: UpdatesView()
            case .post(let id): AnnouncementView(id: id)
            }
        }
    }

    /// Links in a post: to a screen the app draws (a game, a profile,
    /// another post), that screen; to another page of the site, the page in
    /// a sheet; anywhere else, the browser.
    func postLinks() -> some View {
        modifier(PostLinks())
    }
}

/// The bell on Home: the site's Updates page, natively, with a red dot while
/// something has been posted that the player hasn't seen.
struct UpdatesBell: View {
    let unread: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: unread > 0 ? "bell.badge" : "bell")
                .symbolRenderingMode(unread > 0 ? SymbolRenderingMode.multicolor : .monochrome)
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: unread)
        }
        .accessibilityLabel("Updates")
        .accessibilityValue(spokenCount)
    }

    private var spokenCount: String {
        switch unread {
        case 0: ""
        case 1: "1 new post"
        default: "\(unread) new posts"
        }
    }
}

/// The site's announcements, native: what /updates shows, newest first, a
/// card per post down the screen, each read from the site's public API as
/// the end of the feed comes into view (UpdatesModel).
struct UpdatesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let updates = model.updates

        ScrollView {
            LazyVStack(spacing: 16) {
                if !updates.posts.isEmpty {
                    ForEach(Array(updates.posts.enumerated()), id: \.element.id) { index, post in
                        AnnouncementCard(post: post, isNew: index < updates.newCount)
                    }
                    footer(updates)
                } else if updates.total == 0 {
                    ContentUnavailableView("No Updates Yet", systemImage: "bell",
                                           description: Text("News from Empanadas.io shows up here."))
                        .padding(.top, 60)
                } else if updates.error != nil, !updates.isLoading {
                    loadFailed
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .frame(maxWidth: .infinity, minHeight: 320)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
            .readableWidth(ReadableWidth.narrow)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Updates")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await updates.refresh(app: model, fresh: true) }
        .task { await updates.open(app: model) }
        .onChange(of: model.isOnline) { _, online in
            if online, updates.posts.isEmpty { Task { await updates.refresh(app: model) } }
        }
        .postLinks()
    }

    @ViewBuilder
    private func footer(_ updates: UpdatesModel) -> some View {
        if updates.error != nil {
            VStack(spacing: 8) {
                Text(model.isOnline ? "Couldn't load the rest." : "You're offline.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Try Again") {
                    Task {
                        if updates.hasMore {
                            await updates.loadMore(app: model)
                        } else {
                            await updates.refresh(app: model)
                        }
                    }
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        } else if updates.hasMore {
            ProgressView()
                .padding()
                .frame(maxWidth: .infinity)
                // Again after each post, while the end is still in view: a
                // short feed fills the screen.
                .task(id: updates.loads) { await updates.loadMore(app: model) }
        } else {
            Label("You're all caught up", systemImage: "checkmark.circle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
        }
    }

    private var loadFailed: some View {
        ContentUnavailableView {
            Label(model.isOnline ? "Couldn't Load Updates" : "You're Offline",
                  systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
        } description: {
            Text(model.isOnline
                 ? "We couldn't reach our announcements right now. Give it another go."
                 : "Updates show up here once you're back online.")
        } actions: {
            if model.isOnline {
                Button("Try Again") { Task { await model.updates.refresh(app: model) } }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.top, 60)
    }
}

/// One announcement on its own, from a link to it (/updates?post=<id>,
/// empanadas-io://updates/<id>).
struct AnnouncementView: View {
    @Environment(AppModel.self) private var model
    let id: String

    @State private var post: Announcement?
    @State private var isMissing = false
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let post {
                    AnnouncementCard(post: post)
                    Button { model.homePath.append(UpdatesRoute.all) } label: {
                        Label("See All Updates", systemImage: "bell").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                } else if isMissing {
                    ContentUnavailableView {
                        Label("Not Found", systemImage: "magnifyingglass")
                    } description: {
                        Text("That announcement isn't around anymore.")
                    } actions: {
                        Button("Read the Latest") { model.homePath.append(UpdatesRoute.all) }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(.top, 60)
                } else if failed {
                    ContentUnavailableView {
                        Label(model.isOnline ? "Couldn't Load It" : "You're Offline",
                              systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
                    } description: {
                        Text(model.isOnline
                             ? "We couldn't reach our announcements right now. Give it another go."
                             : "This shows up once you're back online.")
                    } actions: {
                        if model.isOnline {
                            Button("Try Again") { Task { await load() } }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(.top, 60)
                } else {
                    ProgressView()
                        .controlSize(.large)
                        .frame(maxWidth: .infinity, minHeight: 320)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
            .readableWidth(ReadableWidth.narrow)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Update")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task {
            if post == nil { await load() }
        }
        .postLinks()
    }

    private func load() async {
        do {
            let reply = try await model.account.announcement(id: id)
            post = reply.post
            isMissing = reply.post == nil
            failed = false
        } catch {
            guard !Task.isCancelled else { return }
            failed = post == nil
        }
    }
}

/// One announcement: its title, who posted it and when, and the post.
struct AnnouncementCard: View {
    @Environment(AppModel.self) private var model
    let post: Announcement
    var isNew = false

    var body: some View {
        Card {
            if isNew {
                Text("New")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.red, in: Capsule())
            }
            Text(post.title.isEmpty ? "Announcement" : post.title)
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
            byline
            Divider()
            PostBody(blocks: post.blocks)
            if let edited = post.edited, !edited.isEmpty {
                Label("Edited \(edited)", systemImage: "pencil")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Opens the author's profile, when the site gave its id.
    @ViewBuilder
    private var byline: some View {
        if let id = post.author.playerID {
            Button {
                model.homePath.append(ProfileRoute.player(id: id, name: post.author.username))
            } label: {
                author
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows their profile")
        } else {
            author
        }
    }

    private var author: some View {
        HStack(spacing: 10) {
            Avatar(url: post.author.pictureURL, size: 34)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(post.author.username)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if post.author.isAdmin {
                        Label("Staff", systemImage: "checkmark.shield.fill")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                }
                if !post.date.isEmpty {
                    Text("Posted \(post.date)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// An announcement's body (PostHTML's blocks), in the app's own type: the
/// reader's text size, light and dark, links in the accent colour.
struct PostBody: View {
    let blocks: [PostBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                content(block)
                    .padding(.top, index == 0 ? 0 : Self.gap(between: blocks[index - 1], and: block))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The items of a list close together; everything else a paragraph apart.
    private static func gap(between previous: PostBlock, and block: PostBlock) -> CGFloat {
        if case .listItem = previous, case .listItem = block { return 6 }
        return 12
    }

    @ViewBuilder
    private func content(_ block: PostBlock) -> some View {
        switch block {
        case .paragraph(let text):
            Text(text)
        case .heading(let text, let level):
            Text(text)
                .font(level <= 2 ? Font.title3.bold() : Font.headline)
                .accessibilityAddTraits(.isHeader)
        case .listItem(let marker, let text, let depth):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(marker)
                    .monospacedDigit()
                    .frame(minWidth: 16, alignment: .trailing)
                Text(text)
            }
            .padding(.leading, CGFloat(depth) * 18)
        case .quote(let text):
            Text(text)
                .foregroundStyle(.secondary)
                .padding(.leading, 14)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.4))
                        .frame(width: 3)
                }
        case .preformatted(let text):
            ScrollView(.horizontal) {
                Text(text)
                    .font(.callout.monospaced())
                    .padding(10)
            }
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .image(let url, let alt):
            PostImage(url: url, alt: alt)
        case .rule:
            Divider()
        }
    }
}

/// A picture in a post: no wider than it is or than the card, loaded and
/// kept like the profile pictures (ImageStore). Left out if it won't load.
private struct PostImage: View {
    let url: URL
    let alt: String

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: image.size.width)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityLabel(alt)
                    .accessibilityHidden(alt.isEmpty)
            } else if !failed {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            }
        }
        .task(id: url) {
            image = await ImageStore.shared.image(for: url)
            failed = image == nil
        }
    }
}

private struct PostLinks: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            guard SiteURLs.isAppURL(url) else { return .systemAction }
            if let route = NativeRoute.of(url) {
                model.navigate(to: route)
            } else {
                model.openWeb(url)
            }
            return .handled
        })
    }
}
