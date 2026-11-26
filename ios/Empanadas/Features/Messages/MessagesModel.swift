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
    /// End-to-end encryption, the same for both of them.
    private(set) var e2ee = ConversationEncryption()
    private(set) var maxLength = MessageText.maxLength
    private(set) var isLoading = false
    private(set) var isLoadingOlder = false
    private(set) var error: Error?
    /// A block, unblock or report under way.
    private(set) var working = false
    var draft = ""
    var actionError: String?
    /// One of the viewer's own being edited in the box, while it still can be.
    private(set) var editing: DirectMessage?
    /// The site's clock minus this device's, from the last answer.
    private var skew: TimeInterval = 0
    /// The last answer's `now`: a poll asks what changed since.
    private var since: Date?

    /// Now, by the site's clock: when an edit is still allowed.
    var serverNow: Date { Date().addingTimeInterval(skew) }

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
        return (canMessage || editing != nil) && length > 0 && length <= maxLength
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
            let thread = try await app.account.thread(with: playerID, after: messages.last?.id, since: since)
            apply(thread)
            for message in thread.changed { replace(message) }
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
        e2ee = thread.e2ee
        if let now = thread.now {
            since = now
            skew = now.timeIntervalSinceNow
        }
    }

    /// An edit or delete, from this device or the other side's.
    private func replace(_ message: DirectMessage) {
        guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        messages[index] = message
        if message.deleted, editing?.id == message.id { stopEditing() }
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
        if let editing {
            let text = MessageText.cleaned(draft)
            stopEditing()
            Task { await saveEdit(editing, text: text, app: app) }
            return
        }
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

    // MARK: - End-to-end encryption

    /// On or off for both of them.
    func setEncrypted(_ on: Bool, app: AppModel) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            e2ee = try await app.account.setEncrypted(on, with: playerID)
            Haptics.play("success")
        } catch {
            Haptics.play("error")
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            actionError = (error as? MessageRefusal).map { MessageRefusal.text($0.reason, name: with?.username ?? "") }
                ?? error.localizedDescription
        }
    }

    // MARK: - Editing and deleting the viewer's own

    func canEdit(_ message: DirectMessage) -> Bool {
        message.canEdit(serverNow: serverNow)
    }

    /// Puts one of the viewer's own in the box to change it.
    func startEditing(_ message: DirectMessage) {
        guard canEdit(message) else {
            actionError = MessageRefusal.text("too_late")
            return
        }
        editing = message
        draft = message.text
    }

    func stopEditing() {
        guard editing != nil else { return }
        editing = nil
        draft = ""
    }

    private func saveEdit(_ message: DirectMessage, text: String, app: AppModel) async {
        guard text != message.text, let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        messages[index].text = text
        do {
            let updated = try await app.account.editMessage(message.id, with: playerID, text: text)
            replace(updated)
            Haptics.play("light")
        } catch {
            Haptics.play("error")
            if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index].text = message.text }
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            actionError = (error as? MessageRefusal).map { MessageRefusal.text($0.reason, name: with?.username ?? "") }
                ?? error.localizedDescription
        }
    }

    /// Deleted for both of them.
    func delete(_ message: DirectMessage, app: AppModel) async {
        guard !working else { return }
        working = true
        defer { working = false }
        do {
            let updated = try await app.account.deleteMessage(message.id)
            replace(updated)
            Haptics.play("success")
        } catch {
            Haptics.play("error")
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            actionError = error.localizedDescription
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
            // The site can't read it: the report carries it as this device opened it.
            try await app.account.reportMessage(message.id, reason: reason, note: note,
                                                text: message.encrypted && !message.sealed ? message.text : "")
            Haptics.play("success")
            return true
        } catch {
            Haptics.play("error")
            actionError = error.localizedDescription
            return false
        }
    }
}
