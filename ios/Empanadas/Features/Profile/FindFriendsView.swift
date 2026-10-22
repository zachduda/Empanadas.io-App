import SwiftUI

/// Find Friends, native: the site's player search (/v2/ios/search) as the
/// player types, with Add Friend and Accept on each result. A result opens the
/// player's profile.
struct FindFriendsView: View {
    @Environment(AppModel.self) private var model
    @State private var finder = FindFriendsModel()

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if !model.isOnline {
                    OfflineNotice(isOnline: false, updatedAt: nil, refreshFailed: false)
                }
                content
            }
            .padding(.horizontal)
            .padding(.bottom, 24)
            .readableWidth(ReadableWidth.narrow)
        }
        .scrollDismissesKeyboard(.immediately)
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Find Friends")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $finder.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Username")
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        // Waits for a pause in the typing, then asks. A new keystroke cancels
        // the wait (and the request, if it had started).
        .task(id: finder.query) {
            if finder.term != nil {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
            }
            await finder.search(app: model)
        }
        .onChange(of: model.isOnline) { _, online in
            if online { Task { await finder.search(app: model) } }
        }
        .navigationDestination(isPresented: $finder.needsCaptcha) {
            WebDestination(url: SiteURLs.page("/v2/captcha"), title: "Quick Check")
        }
        .alert("Couldn't Do That", isPresented: Binding(
            get: { finder.actionError != nil },
            set: { if !$0 { finder.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(finder.actionError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        if finder.term == nil {
            ContentUnavailableView {
                Label("Find Your Friends", systemImage: "person.2.fill")
            } description: {
                Text("Search by username to send a friend request. Friends can see each other's stats, and when they're online.")
            }
            .padding(.top, 40)
        } else if finder.results.isEmpty {
            if finder.isSearching || finder.searched != finder.term && finder.error == nil {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, minHeight: 240)
            } else if let error = finder.error {
                ContentUnavailableView {
                    Label(model.isOnline ? "Couldn't Search" : "You're Offline",
                          systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
                } description: {
                    Text(model.isOnline ? error.localizedDescription : "Players can be searched for once you're back online.")
                } actions: {
                    if model.isOnline {
                        Button("Try Again") { Task { await finder.search(app: model) } }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(.top, 40)
            } else {
                ContentUnavailableView.search(text: finder.query)
                    .padding(.top, 40)
            }
        } else {
            results
        }
    }

    private var results: some View {
        LazyVStack(spacing: 0) {
            ForEach(finder.results) { result in
                ResultRow(result: result, finder: finder)
                if result.id != finder.results.last?.id {
                    Divider().padding(.leading, 66)
                }
            }
            if finder.hasMore {
                ProgressView()
                    .padding()
                    .frame(maxWidth: .infinity)
                    .task { await finder.loadMore(app: model) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .disabled(!model.isOnline)
    }
}

private struct ResultRow: View {
    @Environment(AppModel.self) private var model
    let result: PlayerSearch.Result
    let finder: FindFriendsModel

    private var detail: String? {
        switch result.relation {
        case .me: return "You"
        case .friends: return "Friends"
        case .outgoing: return "Request sent"
        case .incoming: return "Wants to be your friend"
        case .stranger:
            if !result.acceptsRequests { return "Not taking friend requests" }
            return result.isPrivate ? "Private profile" : nil
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            NavigationLink(value: ProfileRoute.player(id: result.relation == .me ? nil : result.playerID,
                                                      name: result.username)) {
                HStack(spacing: 12) {
                    Avatar(url: result.pictureURL, size: 42)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(result.username)
                                .font(.body.weight(.semibold))
                                .lineLimit(1)
                            if result.admin {
                                Image(systemName: "crown.fill")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                                    .accessibilityLabel("Administrator")
                            }
                            if result.supporter {
                                Image(systemName: "heart.fill")
                                    .font(.caption)
                                    .foregroundStyle(Color(hex: 0xFA8072))
                                    .accessibilityLabel("Supporter")
                            }
                            if result.isPrivate {
                                Image(systemName: "lock.fill")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .accessibilityLabel("Private")
                            }
                        }
                        if let detail {
                            Text(detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(result.playerID.isEmpty)

            action
                .disabled(finder.working != nil)
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var action: some View {
        if finder.working == result.playerID {
            ProgressView()
                .frame(minWidth: 60)
        } else {
            switch result.relation {
            case .stranger where result.acceptsRequests:
                Button {
                    Task { await finder.add(result, app: model) }
                } label: {
                    Label("Add", systemImage: "person.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.flappy)
                .controlSize(.small)
                .accessibilityLabel("Add \(result.username) as a friend")
            case .incoming:
                Button {
                    Task { await finder.accept(result, app: model) }
                } label: {
                    Label("Accept", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .tint(Palette.flappy)
                .controlSize(.small)
                .accessibilityLabel("Accept \(result.username)'s friend request")
            case .friends:
                Image(systemName: "person.crop.circle.badge.checkmark")
                    .foregroundStyle(Palette.flappy)
                    .accessibilityHidden(true)
            case .outgoing:
                Image(systemName: "paperplane.fill")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            case .me, .stranger:
                EmptyView()
            }
        }
    }
}
