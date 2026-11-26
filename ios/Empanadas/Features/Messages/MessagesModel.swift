import Foundation

/// A conversation, pushed on the Messages tab's inbox or on whichever tab
/// showed a friend's profile (messagesDestinations()).
enum MessagesRoute: Hashable {
    /// The name is the title until the conversation loads.
    case conversation(id: String, name: String?)
}

/// State behind the inbox: the conversations, newest first, and the players
/// the viewer blocked. Asked for as it shows and every 20 seconds while it
/// does (MessagesView), so a new message moves its conversation to the top.
@MainActor
@Observable
final class InboxModel {
    private(set) var inbox: Inbox?
    private(set) var isLoading = false
    private(set) var error: Error?
    /// The player a block or unblock is being sent for.
    private(set) var working: String?
    var actionError: String?

    /// How often the inbox asks again while it shows.
    static let pollInterval: Duration = .seconds(20)

    func load(app: AppModel) async {
        guard app.session == .signedIn, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh = try await app.account.conversations()
            inbox = fresh
            error = nil
            app.setUnreadMessages(fresh.unread)
        } catch {
            guard !Task.isCancelled else { return }
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            self.error = error
        }
    }

    func unblock(_ person: MessagePerson, app: AppModel) async {
        guard working == nil else { return }
        working = person.playerID
        defer { working = nil }
        do {
            try await app.account.setBlocked(person.playerID, false)
            Haptics.play("success")
            await load(app: app)
        } catch {
            Haptics.play("error")
            actionError = error.localizedDescription
        }
    }
}

/// A message on its way: shown at once, greyed until the site has it, and
/// with Try Again (under the same nonce, so the site keeps it once) if it
/// didn't go.
struct PendingMessage: Identifiable, Equatable {
    let nonce: String
    let text: String
    let at: Date
    var failed: String?

    var id: String { nonce }
}

/// State behind one conversation: its messages, oldest first, what the viewer
/// is typing, and the messages on their way. Asks for what's new every few
/// seconds while it shows (ConversationView), and marks what the other player
/// sent read once it's on screen.
@MainActor
@Observable
final class ConversationModel {
    let playerID: String
    private(set) var with: MessagePerson?
    private(set) var messages: [DirectMessage] = []
    private(set) var pending: [PendingMessage] = []
    private(set) var hasMore = false
    private(set) var seenUpTo = 0
    private(set) var canMessage = false
    /// Why not: not_friends, blocked, unavailable, unverified.
    private(set) var reason: String?
    /// The viewer blocked them.
    private(set) var blocked = false
    private(set) var maxLength = MessageText.maxLength
    private(set) var isLoading = false
    private(set) var isLoadingOlder = false
    private(set) var error: Error?
    /// A block, unblock or report under way.
    private(set) var working = false
    var draft = ""
    var actionError: String?

    /// How often an open conversation asks for what's new.
    static let pollInterval: Duration = .seconds(4)

    init(playerID: String, name: String?) {
        self.playerID = playerID
        if let name { with = MessagePerson(playerID: playerID, username: name) }
    }

    /// The first page has come.
    private(set) var loaded = false

    var title: String { with?.username ?? "Messages" }

    /// What the box can send now: something, and not too much.
    var canSend: Bool {
        let length = MessageText.length(draft)
        return canMessage && length > 0 && length <= maxLength
    }

    /// Shown under the box as the limit nears.
    var charactersLeft: Int? {
        let left = maxLength - MessageText.length(draft)
        return left < 100 ? left : nil
    }

    /// The viewer's newest message, when the other player has read it.
    var seenMessageID: Int? {
        guard pending.isEmpty, let newest = messages.last, newest.fromMe, seenUpTo >= newest.id else { return nil }
        return newest.id
    }

    /// The newest page.
    func load(app: AppModel) async {
        guard app.session == .signedIn, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let thread = try await app.account.thread(with: playerID)
            apply(thread)
            messages = thread.messages
            hasMore = thread.hasMore
            loaded = true
            error = nil
            await markRead(app: app)
        } catch {
            guard !Task.isCancelled else { return }
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            if messages.isEmpty { self.error = error }
        }
    }

    /// What's new since the newest message shown, and whether they've read
    /// the viewer's. Quiet: a poll that fails is tried again by the next.
    func poll(app: AppModel) async {
        guard loaded, app.session == .signedIn, app.isOnline, !isLoading else { return }
        do {
            let thread = try await app.account.thread(with: playerID, after: messages.last?.id)
            apply(thread)
            let known = Set(messages.map(\.id))
            let fresh = thread.messages.filter { !known.contains($0.id) }
            if !fresh.isEmpty {
                messages.append(contentsOf: fresh)
                messages.sort { $0.id < $1.id }
                if fresh.contains(where: { !$0.fromMe }) { Haptics.play("light") }
                await markRead(app: app)
            }
        } catch {
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
        }
    }

    /// The page before the oldest shown, as the top comes into view.
    func loadOlder(app: AppModel) async {
        guard hasMore, !isLoadingOlder, let oldest = messages.first else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let thread = try await app.account.thread(with: playerID, before: oldest.id)
            let known = Set(messages.map(\.id))
            messages = thread.messages.filter { !known.contains($0.id) } + messages
            hasMore = thread.hasMore
        } catch {
            // The next time the top shows, it asks again.
            hasMore = false
        }
    }

    private func apply(_ thread: MessageThread) {
        with = thread.with
        canMessage = thread.canMessage
        reason = thread.reason
        blocked = thread.blocked
        seenUpTo = thread.seenUpTo
        maxLength = thread.maxLength
    }

    /// Marks what they sent read, once it's been seen here.
    private func markRead(app: AppModel) async {
        guard let newest = messages.last(where: { !$0.fromMe && !$0.read }) else { return }
        guard let unread = try? await app.account.markMessagesRead(from: playerID, upTo: newest.id) else { return }
        for index in messages.indices where !messages[index].fromMe && messages[index].id <= newest.id {
            messages[index].read = true
        }
        app.setUnreadMessages(unread)
    }

    // MARK: - Sending

    func send(app: AppModel) {
        guard canSend else { return }
        let message = PendingMessage(nonce: MessageText.nonce(), text: MessageText.cleaned(draft), at: Date())
        draft = ""
        pending.append(message)
        Task { await deliver(message, app: app) }
    }

    func retry(_ message: PendingMessage, app: AppModel) {
        guard let index = pending.firstIndex(where: { $0.id == message.id }) else { return }
        pending[index].failed = nil
        let again = pending[index]
        Task { await deliver(again, app: app) }
    }

    /// Takes a message that didn't go back off the screen.
    func discard(_ message: PendingMessage) {
        pending.removeAll { $0.id == message.id }
    }

    private func deliver(_ message: PendingMessage, app: AppModel) async {
        do {
            let sent = try await app.account.sendMessage(to: playerID, text: message.text, nonce: message.nonce)
            pending.removeAll { $0.id == message.id }
            if !messages.contains(where: { $0.id == sent.message.id }) {
                messages.append(sent.message)
                messages.sort { $0.id < $1.id }
            }
            Haptics.play("light")
        } catch {
            Haptics.play("error")
            let refusal = error as? MessageRefusal
            if let refusal, refusal.closesConversation {
                canMessage = false
                reason = refusal.reason
            }
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            let words = refusal.map { MessageRefusal.text($0.reason, name: with?.username ?? "", maxLength: maxLength) }
                ?? error.localizedDescription
            if let index = pending.firstIndex(where: { $0.id == message.id }) {
                pending[index].failed = words
            }
        }
    }

    // MARK: - Block and report

    func setBlocked(_ block: Bool, app: AppModel) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            let unread = try await app.account.setBlocked(playerID, block)
            Haptics.play("success")
            app.setUnreadMessages(unread)
            // Blocking ends the friendship: profiles and Home say so.
            app.friendsChanged()
            await load(app: app)
        } catch {
            Haptics.play("error")
            actionError = error.localizedDescription
        }
    }

    /// Files the message as a report. True when the site has it.
    func report(_ message: DirectMessage, reason: ReportReason, note: String, app: AppModel) async -> Bool {
        guard !working else { return false }
        working = true
        defer { working = false }
        do {
            try await app.account.reportMessage(message.id, reason: reason, note: note)
            Haptics.play("success")
            return true
        } catch {
            Haptics.play("error")
            actionError = error.localizedDescription
            return false
        }
    }
}
