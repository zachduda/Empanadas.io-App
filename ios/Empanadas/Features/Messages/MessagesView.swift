import SwiftUI
import UIKit

// Messages, native: direct messages between friends, from the site's
// /v2/app/messages.php. The inbox (MessagesView) and a conversation
// (ConversationView) are pushed on whichever tab opened them: Home's
// Messages button, a friend's profile, a deep link or a link to /v2/messages.
// Everything a player wrote is shown as text, never as markup.

extension View {
    /// Lets NavigationLink(value: MessagesRoute) work in this navigation
    /// stack. profileDestinations() adds it, so every stack that shows a
    /// profile can show Messages too.
    func messagesDestinations() -> some View {
        navigationDestination(for: MessagesRoute.self) { route in
            switch route {
            case .inbox: MessagesView()
            case .conversation(let id, let name): ConversationView(id: id, name: name)
            }
        }
    }
}

/// Home's Messages button, with how many are unread.
struct MessagesButton: View {
    let unread: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: unread > 0 ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")
                .symbolEffect(.bounce, value: unread)
                .overlay(alignment: .topTrailing) {
                    if unread > 0 {
                        Text(unread > 99 ? "99+" : "\(unread)")
                            .font(.caption2.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(.red))
                            .offset(x: 10, y: -8)
                            .accessibilityHidden(true)
                    }
                }
        }
        .accessibilityLabel("Messages")
        .accessibilityValue(unread == 0 ? "" : unread == 1 ? "1 unread" : "\(unread) unread")
    }
}

/// How the screens write a message's time.
enum MessageTime {
    /// The inbox: the time today, the weekday this week, the date before.
    static func short(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if now.timeIntervalSince(date) < 60 { return "Now" }
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day {
            if days == 1 { return "Yesterday" }
            if days < 7 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// Between two messages far apart.
    static func gap(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

    /// A gap this long between two messages gets the time written between them.
    static let gapAfter: TimeInterval = 15 * 60
}

// MARK: - The inbox

struct MessagesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var inbox = InboxModel()
    @State private var composing = false
    @State private var picked: MessagePerson?

    var body: some View {
        List {
            if PushNotifications.shared.permission == .notAsked && inbox.inbox != nil {
                Section {
                    NotificationsCard()
                }
            }
            if let data = inbox.inbox {
                if !data.conversations.isEmpty {
                    Section {
                        ForEach(data.conversations) { conversation in
                            NavigationLink(value: MessagesRoute.conversation(id: conversation.with.playerID,
                                                                             name: conversation.with.username)) {
                                ConversationRow(conversation: conversation)
                            }
                            .disabled(conversation.with.playerID.isEmpty)
                        }
                    }
                }
                if !data.blocked.isEmpty {
                    Section {
                        ForEach(data.blocked, id: \.playerID) { person in
                            HStack(spacing: 12) {
                                Avatar(url: person.pictureURL, size: 36)
                                Text(person.username)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                if inbox.working == person.playerID {
                                    ProgressView()
                                } else {
                                    Button("Unblock") { Task { await inbox.unblock(person, app: model) } }
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                        .disabled(inbox.working != nil)
                                }
                            }
                        }
                    } header: {
                        Text("Blocked")
                    } footer: {
                        Text("You and they can't message each other or send friend requests while they're blocked.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { placeholder }
        .navigationTitle("Messages")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New Message")
                    .disabled(!model.isOnline)
            }
        }
        .refreshable { await inbox.load(app: model) }
        // While it shows and the app is in front: now, then every 20 seconds.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await inbox.load(app: model)
            while !Task.isCancelled {
                try? await Task.sleep(for: InboxModel.pollInterval)
                guard !Task.isCancelled else { return }
                guard model.isOnline, !model.isLowDataMode else { continue }
                await inbox.load(app: model)
            }
        }
        .sheet(isPresented: $composing) {
            NewMessageSheet { person in
                composing = false
                picked = person
            }
        }
        .navigationDestination(item: $picked) { person in
            ConversationView(id: person.playerID, name: person.username)
        }
        .alert("Couldn't Do That", isPresented: Binding(
            get: { inbox.actionError != nil },
            set: { if !$0 { inbox.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(inbox.actionError ?? "")
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if let data = inbox.inbox {
            if data.conversations.isEmpty && data.blocked.isEmpty {
                ContentUnavailableView {
                    Label("No Messages Yet", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Message a friend and your conversations show up here.")
                } actions: {
                    Button("New Message") { composing = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        } else if let error = inbox.error {
            ContentUnavailableView {
                Label(model.isOnline ? "Couldn't Load Messages" : "You're Offline",
                      systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
            } description: {
                Text(model.isOnline ? error.localizedDescription : "Your messages show up here once you're back online.")
            } actions: {
                if model.isOnline {
                    Button("Try Again") { Task { await inbox.load(app: model) } }
                        .buttonStyle(.borderedProminent)
                }
            }
        } else {
            ProgressView()
                .controlSize(.large)
        }
    }
}

private struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 12) {
            PresenceAvatar(person: conversation.with, size: 46)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(conversation.with.username)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let sent = conversation.last.sent {
                        Text(MessageTime.short(sent))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(alignment: .top) {
                    Text(verbatim: (conversation.last.fromMe ? "You: " : "") + conversation.last.preview)
                        .font(.subheadline.weight(conversation.unread > 0 ? .semibold : .regular))
                        .foregroundStyle(conversation.unread > 0 ? Color.primary : Color.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 6)
                    if conversation.unread > 0 {
                        Text("\(conversation.unread)")
                            .font(.caption.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.accentColor))
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityValue(conversation.unread > 0 ? "\(conversation.unread) unread" : "")
    }
}

/// A player's picture with a dot for whether they're online (friends only).
private struct PresenceAvatar: View {
    let person: MessagePerson
    var size: CGFloat = 40

    var body: some View {
        Avatar(url: person.pictureURL, size: size)
            .overlay(alignment: .bottomTrailing) {
                if let state = person.state, state == "online" || state == "idle" {
                    Circle()
                        .fill(state == "online" ? Palette.online : Palette.idle)
                        .frame(width: size * 0.28, height: size * 0.28)
                        .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                        .accessibilityLabel(person.label ?? state)
                }
            }
    }
}

/// Asks to notify the player of new messages: in the inbox, until they've
/// answered the system's question.
private struct NotificationsCard: View {
    @State private var asking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Know when friends message you", systemImage: "bell.badge.fill")
                .font(.headline)
                .symbolRenderingMode(.multicolor)
            Text("Get a notification for each new message, even when the app is closed.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                asking = true
                Task {
                    await PushNotifications.shared.requestPermission()
                    asking = false
                }
            } label: {
                Text("Turn On Notifications")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(asking)
        }
        .padding(.vertical, 6)
    }
}

// MARK: - New message

/// One of the player's friends, to start or carry on a conversation with.
private struct NewMessageSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let pick: (MessagePerson) -> Void

    @State private var friends: [PlayerProfile.Friend]?
    @State private var error: Error?
    @State private var filter = ""

    private var shown: [PlayerProfile.Friend] {
        let list = friends ?? []
        let term = filter.trimmingCharacters(in: .whitespaces)
        return term.isEmpty ? list : list.filter { $0.username.localizedCaseInsensitiveContains(term) }
    }

    var body: some View {
        NavigationStack {
            List(shown) { friend in
                Button {
                    pick(MessagePerson(playerID: friend.playerID, username: friend.username, pfp: friend.pfp))
                } label: {
                    HStack(spacing: 12) {
                        Avatar(url: friend.pictureURL, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(friend.username)
                                .foregroundStyle(.primary)
                            if let label = friend.label {
                                Text(label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .disabled(friend.playerID.isEmpty)
            }
            .overlay {
                if friends == nil, let error {
                    ContentUnavailableView("Couldn't Load Your Friends", systemImage: "exclamationmark.triangle",
                                           description: Text(error.localizedDescription))
                } else if friends == nil {
                    ProgressView()
                } else if friends?.isEmpty == true {
                    ContentUnavailableView("No Friends Yet", systemImage: "person.2",
                                           description: Text("Once you have friends, you can message them here. Find them from Home."))
                } else if shown.isEmpty {
                    ContentUnavailableView.search(text: filter)
                }
            }
            .searchable(text: $filter, prompt: "Search your friends")
            .navigationTitle("New Message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task {
                do {
                    let own = try await model.account.profile()
                    friends = (own.friends?.accepted ?? [])
                        .sorted { $0.username.localizedCaseInsensitiveCompare($1.username) == .orderedAscending }
                } catch {
                    self.error = error
                }
            }
        }
    }
}

// MARK: - A conversation

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var conversation: ConversationModel
    @State private var reporting: (message: DirectMessage, reason: ReportReason)?
    @State private var reportNote = ""
    @State private var offeringBlock = false
    @State private var confirmingBlock = false
    @State private var showingProfile = false
    @FocusState private var typing: Bool

    init(id: String, name: String?) {
        _conversation = State(initialValue: ConversationModel(playerID: id, name: name))
    }

    private var name: String { conversation.with?.username ?? "them" }

    /// What the scroll view shows, in order: the time before a message far
    /// from the one before it, the messages, the ones on their way, and Seen.
    private enum Row: Identifiable {
        case gap(Date)
        case message(DirectMessage)
        case pending(PendingMessage)
        case seen

        var id: String {
            switch self {
            case .gap(let date): "gap-\(date.timeIntervalSince1970)"
            case .message(let message): "m-\(message.id)"
            case .pending(let message): "p-\(message.id)"
            case .seen: "seen"
            }
        }
    }

    private var rows: [Row] {
        var out: [Row] = []
        var previous: Date?
        for message in conversation.messages {
            if let sent = message.sent, previous.map({ sent.timeIntervalSince($0) > MessageTime.gapAfter }) ?? true {
                out.append(.gap(sent))
            }
            out.append(.message(message))
            if let sent = message.sent { previous = sent }
        }
        out += conversation.pending.map { Row.pending($0) }
        if conversation.seenMessageID != nil { out.append(.seen) }
        return out
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    if conversation.hasMore {
                        ProgressView()
                            .padding(.vertical, 8)
                            .task { await conversation.loadOlder(app: model) }
                    }
                    ForEach(rows) { row in
                        rowView(row)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .readableWidth(ReadableWidth.narrow)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .overlay { placeholder }
            .onChange(of: conversation.messages.last?.id) { _, _ in
                withAnimation(.smooth) { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: conversation.pending.count) { _, _ in
                withAnimation(.smooth) { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: typing) { _, focused in
                if focused { withAnimation(.smooth) { proxy.scrollTo("end", anchor: .bottom) } }
            }
        }
        // Its notifications aren't shown while it is on screen, and the ones
        // already delivered have been seen.
        .onAppear {
            model.openConversation = conversation.playerID
            PushNotifications.shared.conversationOpened(with: conversation.playerID)
        }
        .onDisappear {
            if model.openConversation == conversation.playerID { model.openConversation = nil }
        }
        .onChange(of: conversation.messages.count) { _, _ in
            PushNotifications.shared.conversationOpened(with: conversation.playerID)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle(conversation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showingProfile = true } label: {
                        Label("View Profile", systemImage: "person.crop.circle")
                    }
                    if conversation.loaded {
                        if conversation.blocked {
                            Button { Task { await conversation.setBlocked(false, app: model) } } label: {
                                Label("Unblock \(name)", systemImage: "hand.raised.slash")
                            }
                        } else {
                            Button(role: .destructive) { confirmingBlock = true } label: {
                                Label("Block \(name)", systemImage: "hand.raised")
                            }
                        }
                    }
                } label: {
                    PresenceAvatar(person: conversation.with ?? MessagePerson(playerID: conversation.playerID, username: ""), size: 30)
                }
                .accessibilityLabel("\(name), more")
                .disabled(conversation.working)
            }
        }
        .navigationDestination(isPresented: $showingProfile) {
            ProfileView(id: conversation.playerID, name: conversation.with?.username)
        }
        // While it shows and the app is in front: the newest page, then
        // what's new every few seconds.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            if conversation.loaded {
                await conversation.poll(app: model)
            } else {
                await conversation.load(app: model)
            }
            while !Task.isCancelled {
                try? await Task.sleep(for: ConversationModel.pollInterval)
                guard !Task.isCancelled else { return }
                await conversation.poll(app: model)
            }
        }
        .confirmationDialog("Block \(name)?", isPresented: $confirmingBlock, titleVisibility: .visible) {
            Button("Block", role: .destructive) {
                Task { await conversation.setBlocked(true, app: model) }
            }
        } message: {
            Text("You won't be able to message each other or send friend requests, and you'll no longer be friends. They won't be told.")
        }
        .alert("Report This Message?", isPresented: Binding(
            get: { reporting != nil },
            set: { if !$0 { reporting = nil } }
        ), presenting: reporting) { target in
            TextField("Anything to add? (optional)", text: $reportNote)
            Button("Report", role: .destructive) {
                let note = reportNote
                reportNote = ""
                Task {
                    let filed = await conversation.report(target.message, reason: target.reason, note: note, app: model)
                    if filed && !conversation.blocked { offeringBlock = true }
                }
            }
            Button("Cancel", role: .cancel) { reportNote = "" }
        } message: { target in
            Text("Reported for \(target.reason.title.lowercased()). We'll take a look; \(name) won't know who reported it.")
        }
        .alert("Thanks for Telling Us", isPresented: $offeringBlock) {
            Button("Block \(name)", role: .destructive) {
                Task { await conversation.setBlocked(true, app: model) }
            }
            Button("Not Now", role: .cancel) {}
        } message: {
            Text("Do you want to block \(name) too? You won't be able to message each other.")
        }
        .alert("Couldn't Do That", isPresented: Binding(
            get: { conversation.actionError != nil },
            set: { if !$0 { conversation.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(conversation.actionError ?? "")
        }
    }

    @ViewBuilder
    private func rowView(_ row: Row) -> some View {
        switch row {
        case .gap(let date):
            Text(MessageTime.gap(date))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 12)
                .padding(.bottom, 4)
        case .message(let message):
            Bubble(text: message.text, fromMe: message.fromMe, sent: message.sent, faded: false, sender: name)
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = message.text
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                    if !message.fromMe {
                        Menu {
                            ForEach(ReportReason.allCases) { reason in
                                Button(reason.title) { reporting = (message, reason) }
                            }
                        } label: {
                            Label("Report…", systemImage: "exclamationmark.bubble")
                        }
                    }
                }
        case .pending(let message):
            VStack(alignment: .trailing, spacing: 3) {
                Bubble(text: message.text, fromMe: true, sent: message.at, faded: message.failed == nil, sender: name)
                if let failed = message.failed {
                    HStack(spacing: 10) {
                        Text(failed)
                            .multilineTextAlignment(.trailing)
                        Button("Try Again") { conversation.retry(message, app: model) }
                            .fontWeight(.semibold)
                        Button("Delete", role: .destructive) { conversation.discard(message) }
                    }
                    .font(.caption)
                    .foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .seen:
            Text("Seen")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 4)
        }
    }

    @ViewBuilder
    private var placeholder: some View {
        if !conversation.loaded {
            if let error = conversation.error {
                ContentUnavailableView {
                    Label(model.isOnline ? "Couldn't Load This Conversation" : "You're Offline",
                          systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
                } description: {
                    Text(model.isOnline ? error.localizedDescription : "Messages show up here once you're back online.")
                } actions: {
                    if model.isOnline {
                        Button("Try Again") { Task { await conversation.load(app: model) } }
                            .buttonStyle(.borderedProminent)
                    }
                }
            } else {
                ProgressView()
                    .controlSize(.large)
            }
        } else if conversation.messages.isEmpty && conversation.pending.isEmpty {
            ContentUnavailableView {
                Label(conversation.canMessage ? "Say Hi to \(name)!" : "No Messages Yet", systemImage: "hand.wave")
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        @Bindable var conversation = conversation
        if conversation.loaded && !conversation.canMessage {
            Text(MessageRefusal.text(conversation.reason, name: conversation.with?.username ?? "",
                                     maxLength: conversation.maxLength))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding()
                .background(.bar)
        } else if conversation.loaded {
            VStack(alignment: .trailing, spacing: 2) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message \(name)", text: $conversation.draft, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($typing)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Color(uiColor: .secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    Button {
                        conversation.send(app: model)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 34))
                            .symbolRenderingMode(.hierarchical)
                    }
                    .disabled(!conversation.canSend || !model.isOnline)
                    .accessibilityLabel("Send")
                }
                if let left = conversation.charactersLeft {
                    Text("\(left)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(left < 0 ? Color.red : Color.secondary)
                        .padding(.trailing, 48)
                        .accessibilityLabel(left < 0 ? "\(-left) characters over" : "\(left) characters left")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .readableWidth(ReadableWidth.narrow)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
    }
}

/// One message, on its side: the player's own in the accent colour on the
/// right, the other player's in grey on the left.
private struct Bubble: View {
    let text: String
    let fromMe: Bool
    let sent: Date?
    /// On its way.
    let faded: Bool
    let sender: String

    var body: some View {
        HStack {
            if fromMe { Spacer(minLength: 48) }
            Text(verbatim: text)
                .textSelection(.enabled)
                .padding(.horizontal, 13)
                .padding(.vertical, 8)
                .foregroundStyle(fromMe ? Color.white : Color.primary)
                .background(fromMe ? Color.accentColor : Color(uiColor: .secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .opacity(faded ? 0.6 : 1)
            if !fromMe { Spacer(minLength: 48) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((fromMe ? "You" : sender) + ": " + text)
        .accessibilityValue(sent.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "")
    }
}
