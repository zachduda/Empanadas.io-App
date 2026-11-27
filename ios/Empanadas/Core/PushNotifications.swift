import Foundation
import UIKit
import UserNotifications

// Push notifications, from the site through Apple's push service (the site's
// v2/_push.php): a direct message, a friend request, a request accepted. The
// app asks the player first (the Messages inbox's card, or Settings), then
// registers with APNs at every launch while signed in and hands the site its
// device token (/v2/app/push.php). A message's notification has Reply and
// Mark as Read on it, a friend request's Accept and Decline, all done without
// opening the app; a tap opens the conversation or the profile. One for the
// conversation already on screen isn't shown. At sign-out the token is handed
// back, so the next account on this phone doesn't get the last one's.

/// What a message's notification carries for the app ("dm" beside "aps":
/// pushMessagePayload() in the site's v2/_push.php).
/// A deleted message's silent notification ("dm": retract, badge, unread).
struct MessageRetraction: Equatable, Sendable {
    let messageID: Int
    let badge: Int?
    let unread: Int?

    /// Nil for anything else.
    init?(userInfo: [AnyHashable: Any]) {
        guard let dm = userInfo["dm"] as? [String: Any],
              let id = (dm["retract"] as? NSNumber)?.intValue, id > 0 else { return nil }
        messageID = id
        badge = (dm["badge"] as? NSNumber)?.intValue
        unread = (dm["unread"] as? NSNumber)?.intValue
    }
}

struct MessageNotification: Equatable, Sendable {
    /// The sender's player id.
    let from: String
    let messageID: Int
    /// The sender's name, for what the app says about a reply.
    let name: String?
    /// The messages unread, apart from the badge (which counts friend
    /// requests too).
    let unread: Int?
    /// A reply from the notification that didn't go: the app's own
    /// notification saying so carries it, for the conversation's box.
    let draft: String?

    init(from: String, messageID: Int, name: String? = nil, unread: Int? = nil, draft: String? = nil) {
        self.from = from
        self.messageID = messageID
        self.name = name
        self.unread = unread
        self.draft = draft
    }

    /// Nil for a notification that isn't a message's.
    init?(userInfo: [AnyHashable: Any]) {
        guard let dm = userInfo["dm"] as? [String: Any],
              let from = dm["from"] as? String, PlayerID.isValid(from) else { return nil }
        self.from = from.lowercased()
        messageID = (dm["message"] as? NSNumber)?.intValue ?? 0
        name = (dm["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        unread = (dm["unread"] as? NSNumber)?.intValue
        draft = (dm["draft"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// As the site writes it, for the app's own notifications.
    var userInfo: [String: Any] {
        var dm: [String: Any] = ["from": from, "message": messageID]
        if let name { dm["name"] = name }
        if let draft { dm["draft"] = draft }
        return ["dm": dm]
    }

    /// How the site groups one conversation's notifications (thread-id).
    static func threadID(for playerID: String) -> String {
        "dm-" + (PlayerID.raw(playerID) ?? playerID.lowercased())
    }
}

/// What a friend request's notification carries ("friend":
/// pushFriendPayload() in the site's v2/_push.php).
struct FriendNotification: Equatable, Sendable {
    enum Kind: String, Sendable {
        /// They asked: Accept and Decline are on it.
        case request
        /// They accepted the player's request.
        case accepted
    }

    let from: String
    let name: String
    let kind: Kind

    init(from: String, name: String, kind: Kind) {
        self.from = from
        self.name = name
        self.kind = kind
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let friend = userInfo["friend"] as? [String: Any],
              let from = friend["from"] as? String, PlayerID.isValid(from) else { return nil }
        self.from = from.lowercased()
        name = friend["name"] as? String ?? ""
        kind = Kind(rawValue: friend["kind"] as? String ?? "") ?? .request
    }

    var userInfo: [String: Any] {
        ["friend": ["from": from, "name": name, "kind": kind.rawValue]]
    }

    /// The site's thread-id for them all.
    static let threadID = "friends"
}

/// One of the site's notifications, as the app reads it.
enum PushNotice: Equatable, Sendable {
    case message(MessageNotification)
    case friend(FriendNotification)

    init?(userInfo: [AnyHashable: Any]) {
        if let message = MessageNotification(userInfo: userInfo) {
            self = .message(message)
        } else if let friend = FriendNotification(userInfo: userInfo) {
            self = .friend(friend)
        } else {
            return nil
        }
    }

    /// Where a tap goes.
    var route: NativeRoute {
        switch self {
        case .message(let message): .messages(message.from)
        case .friend(let friend): .profile(friend.from)
        }
    }
}

/// The buttons on the site's notifications: the categories its payloads
/// name ("category" in aps).
enum NotificationActions {
    static let messageCategory = "message"
    static let friendRequestCategory = "friend_request"
    static let reply = "reply"
    static let markRead = "read"
    static let accept = "accept"
    static let decline = "decline"

    static var categories: Set<UNNotificationCategory> {
        // Answering for the player needs the phone unlocked: someone holding
        // it locked can read what the lock screen shows, and no more.
        let replyButton = UNTextInputNotificationAction(
            identifier: reply, title: "Reply", options: [.authenticationRequired],
            icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let readButton = UNNotificationAction(identifier: markRead, title: "Mark as Read", options: [],
                                              icon: UNNotificationActionIcon(systemImageName: "envelope.open"))
        let acceptButton = UNNotificationAction(identifier: accept, title: "Accept", options: [.authenticationRequired],
                                                icon: UNNotificationActionIcon(systemImageName: "person.crop.circle.badge.checkmark"))
        let declineButton = UNNotificationAction(identifier: decline, title: "Decline",
                                                 options: [.authenticationRequired, .destructive],
                                                 icon: UNNotificationActionIcon(systemImageName: "xmark"))
        return [
            UNNotificationCategory(identifier: messageCategory, actions: [replyButton, readButton], intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: "New message", options: []),
            UNNotificationCategory(identifier: friendRequestCategory, actions: [acceptButton, declineButton], intentIdentifiers: [],
                                   hiddenPreviewsBodyPlaceholder: "Friend request", options: []),
        ]
    }
}

/// The device token as the site takes it, and which APNs it is for.
enum PushToken {
    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// A build run from Xcode gets its tokens from APNs' sandbox; TestFlight
    /// and the App Store from production.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }
}

/// Whether the player lets the app notify them, as the screens show it.
enum PushPermission: Equatable, Sendable {
    /// Not asked yet: the inbox offers to turn them on.
    case notAsked
    case on
    /// Turned off, here or in the Settings app: only the Settings app can
    /// turn them back on.
    case off
}

@MainActor
@Observable
final class PushNotifications: NSObject {
    /// One for the app: it is the notification center's delegate from launch
    /// (AppDelegate), before the model exists.
    static let shared = PushNotifications()

    private(set) var permission: PushPermission = .notAsked

    /// The model, once there is one (AppModel.init). A tap that came first
    /// waits for it.
    @ObservationIgnored weak var app: AppModel? {
        didSet { openPending() }
    }

    @ObservationIgnored private var pendingTap: PushNotice?
    @ObservationIgnored private let defaults = UserDefaults.standard

    /// The token APNs gave this device last, kept so it can be handed back
    /// at sign-out (even after a relaunch).
    private static let tokenKey = "push.token"
    /// The token, and when, the site was last given for the account signed in.
    private static let sentTokenKey = "push.sentToken"
    private static let sentAtKey = "push.sentAt"
    /// A token still to hand back: the sign-out couldn't reach the site.
    private static let unregisterKey = "push.unregisterPending"
    /// How often a token the site already has is sent again, so it is kept
    /// up to date (and back if it was lost).
    static let resendAfter: TimeInterval = 7 * 24 * 60 * 60

    /// The buttons on the site's notifications, before any arrives
    /// (AppDelegate, at launch).
    nonisolated static func registerCategories() {
        UNUserNotificationCenter.current().setNotificationCategories(NotificationActions.categories)
    }

    // MARK: - Permission

    /// Reads what the player has allowed; registers with APNs when they have
    /// and the app is signed in. As the app starts and comes to the front.
    func refresh() async {
        permission = await Self.currentPermission()
        // A hand-back from the last sign-out first: once the token is
        // registered for the account signed in now, it must not then arrive
        // and take it away.
        await retryUnregister()
        if permission == .on, app?.session == .signedIn {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Asks the player (the system's prompt, once). True when they said yes.
    @discardableResult
    func requestPermission() async -> Bool {
        let granted = await Self.ask()
        permission = await Self.currentPermission()
        if granted, app?.session == .signedIn {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return granted
    }

    func openSystemSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    // MARK: - The device token

    /// APNs gave this device its token (AppDelegate): the site gets it, unless
    /// it already has it for this account and lately.
    func didRegister(_ deviceToken: Data) {
        let token = PushToken.hex(deviceToken)
        defaults.set(token, forKey: Self.tokenKey)
        guard let app, app.session == .signedIn else { return }
        if defaults.string(forKey: Self.sentTokenKey) == token,
           let at = defaults.object(forKey: Self.sentAtKey) as? Date,
           Date().timeIntervalSince(at) < Self.resendAfter {
            return
        }
        Task {
            do {
                try await app.account.registerPush(token: token, environment: PushToken.environment)
                // A sign-out still to hand this token back would take it from
                // the account just given it.
                if defaults.string(forKey: Self.unregisterKey) == token {
                    defaults.removeObject(forKey: Self.unregisterKey)
                }
                defaults.set(token, forKey: Self.sentTokenKey)
                defaults.set(Date(), forKey: Self.sentAtKey)
            } catch {
                // Tried again at the next launch or return to the front.
            }
        }
    }

    /// Signed in: this device's notifications are the new account's.
    func signedIn() {
        defaults.removeObject(forKey: Self.sentTokenKey)
        defaults.removeObject(forKey: Self.sentAtKey)
        Task { await refresh() }
    }

    /// Signed out: the site stops notifying this device, the badge goes, and
    /// so do the last account's notifications. A hand-back that can't reach
    /// the site is tried again later; no session is needed for it.
    func signedOut() {
        defaults.removeObject(forKey: Self.sentTokenKey)
        defaults.removeObject(forKey: Self.sentAtKey)
        if let token = defaults.string(forKey: Self.tokenKey) {
            defaults.set(token, forKey: Self.unregisterKey)
            Task { await retryUnregister() }
        }
        Task {
            await Self.setBadge(0)
            await Self.removeDelivered(thread: nil)
        }
    }

    private func retryUnregister() async {
        guard let token = defaults.string(forKey: Self.unregisterKey), let app else { return }
        do {
            try await app.account.unregisterPush(token: token)
            if defaults.string(forKey: Self.unregisterKey) == token {
                defaults.removeObject(forKey: Self.unregisterKey)
            }
        } catch {
            // Kept for the next try.
        }
    }

    // MARK: - On screen

    /// The app icon's badge: what waits on the player (AppModel.badgeCount).
    /// Set whatever the permission says: the system ignores it when badges
    /// are off, and a launch for a notification's button hasn't read it yet.
    func setBadge(_ count: Int) {
        Task { await Self.setBadge(count) }
    }

    /// A silent notification (the site's pushRetractPayload()): a message was
    /// deleted, so its notification comes off the lock screen and Notification
    /// Center, and the badge is what still waits.
    func retract(_ retraction: MessageRetraction) async {
        await Self.removeDelivered(message: retraction.messageID)
        if let badge = retraction.badge { await Self.setBadge(badge) }
        if let unread = retraction.unread { app?.setUnreadMessages(unread) }
    }

    /// A conversation is on screen: its notifications have been seen.
    func conversationOpened(with playerID: String) {
        let thread = MessageNotification.threadID(for: playerID)
        Task { await Self.removeDelivered(thread: thread) }
    }

    /// A notification was tapped: its conversation or profile, once the app
    /// can show it.
    private func open(_ notice: PushNotice) {
        pendingTap = notice
        openPending()
    }

    private func openPending() {
        guard let notice = pendingTap, let app else { return }
        pendingTap = nil
        if case .message(let message) = notice {
            // A reply that didn't go waits in the conversation's box.
            if let draft = message.draft { app.unsentReply = (message.from, draft) }
            if let open = app.openConversation, PlayerID.same(open, message.from) { return }
        }
        app.navigate(to: notice.route)
    }

    /// Whether a notification arriving while the app is in front shows: not
    /// for the conversation on screen, which shows the message itself. Home
    /// hears of a friend request at once.
    private func presentation(for notice: PushNotice?) -> UNNotificationPresentationOptions {
        switch notice {
        case .message(let message):
            if let unread = message.unread { app?.setUnreadMessages(unread) }
            if let open = app?.openConversation, PlayerID.same(open, message.from) { return [] }
        case .friend:
            app?.friendsChanged()
        case nil:
            break
        }
        return [.banner, .list, .sound]
    }

    // MARK: - The buttons on a notification

    private func perform(_ action: String, on notice: PushNotice, text: String?, notificationID: String) async {
        switch (notice, action) {
        case (_, UNNotificationDefaultActionIdentifier):
            open(notice)
        case (.message(let message), NotificationActions.reply):
            await reply(text ?? "", to: message)
        case (.message(let message), NotificationActions.markRead):
            await markRead(message)
        case (.friend(let friend), NotificationActions.accept):
            await answer(friend, accept: true, notificationID: notificationID)
        case (.friend(let friend), NotificationActions.decline):
            await answer(friend, accept: false, notificationID: notificationID)
        default:
            break
        }
    }

    /// Reply: sent as the conversation's box sends it, and what they sent is
    /// then read. One that doesn't go says so in a notification of the app's
    /// own, which opens the conversation with the reply in its box.
    private func reply(_ text: String, to message: MessageNotification) async {
        guard let app, app.session == .signedIn else { return }
        let text = MessageText.cleaned(text)
        guard !text.isEmpty else { return }
        // One nonce for both tries: if the first reached the site and only
        // its answer was lost, the site keeps it once.
        let nonce = MessageText.nonce()
        var failure: Error?
        for _ in 0..<2 {
            do {
                _ = try await app.account.sendMessage(to: message.from, text: text, nonce: nonce)
                failure = nil
                break
            } catch {
                failure = error
                if (error as? AccountError) != .network { break }
            }
        }
        guard let failure else {
            await markRead(message)
            return
        }
        if (failure as? AccountError) == .signedOut { app.observe(.unsure) }
        let name = message.name ?? "them"
        let why = (failure as? MessageRefusal).map { MessageRefusal.text($0.reason, name: name, maxLength: MessageText.maxLength) }
            ?? failure.localizedDescription
        let unsent = MessageNotification(from: message.from, messageID: message.messageID, name: message.name, draft: text)
        await Self.post(title: "Your reply to \(name) wasn't sent", body: why + " Tap to try again.", about: .message(unsent))
    }

    /// Mark as Read: what they sent up to this message, and its notifications
    /// go.
    private func markRead(_ message: MessageNotification) async {
        guard let app, app.session == .signedIn else { return }
        if let unread = try? await app.account.markMessagesRead(from: message.from,
                                                                upTo: message.messageID > 0 ? message.messageID : nil) {
            app.setUnreadMessages(unread)
        }
        await Self.removeDelivered(thread: MessageNotification.threadID(for: message.from))
    }

    /// Accept or Decline, as the profile's buttons do; the badge and Home
    /// follow. One that can't be done says why, and opens their profile.
    private func answer(_ friend: FriendNotification, accept: Bool, notificationID: String) async {
        guard let app, app.session == .signedIn else { return }
        do {
            try await app.account.answerFriendRequest(from: friend.from, accept: accept)
            await Self.removeDelivered(ids: [notificationID])
            await app.friendsChanged().value
        } catch {
            if (error as? AccountError) == .signedOut { app.observe(.unsure) }
            let name = friend.name.isEmpty ? "their" : friend.name + "'s"
            await Self.post(title: "Couldn't \(accept ? "accept" : "decline") \(name) friend request",
                            body: error.localizedDescription, about: .friend(friend))
        }
    }

    // MARK: - The notification center, away from the main actor

    private nonisolated static func currentPermission() async -> PushPermission {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .notDetermined: .notAsked
        case .denied: .off
        default: .on
        }
    }

    private nonisolated static func ask() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    private nonisolated static func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }

    /// One conversation's notifications, or with no thread all of them.
    private nonisolated static func removeDelivered(thread: String?) async {
        let center = UNUserNotificationCenter.current()
        guard let thread else {
            center.removeAllDeliveredNotifications()
            return
        }
        let ids = await center.deliveredNotifications()
            .filter { $0.request.content.threadIdentifier == thread }
            .map(\.request.identifier)
        if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }

    /// One message's notification, by its id ("dm" "message").
    private nonisolated static func removeDelivered(message id: Int) async {
        let center = UNUserNotificationCenter.current()
        let ids = await center.deliveredNotifications()
            .filter { (($0.request.content.userInfo["dm"] as? [String: Any])?["message"] as? NSNumber)?.intValue == id }
            .map(\.request.identifier)
        if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }

    private nonisolated static func removeDelivered(ids: [String]) async {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
    }

    /// A notification of the app's own, now: something done from a
    /// notification's button that didn't work. A tap on it opens what
    /// `notice` is about.
    private nonisolated static func post(title: String, body: String, about notice: PushNotice) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        switch notice {
        case .message(let message):
            content.threadIdentifier = MessageNotification.threadID(for: message.from)
            content.userInfo = message.userInfo
        case .friend(let friend):
            content.threadIdentifier = FriendNotification.threadID
            content.userInfo = friend.userInfo
        }
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}

extension PushNotifications: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let notice = PushNotice(userInfo: notification.request.content.userInfo)
        return await presentation(for: notice)
    }

    /// A tap, or one of the buttons: the system waits for this to return, so
    /// a button's request is finished before the app is suspended again.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        guard let notice = PushNotice(userInfo: response.notification.request.content.userInfo) else { return }
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        let id = response.notification.request.identifier
        await perform(action, on: notice, text: text, notificationID: id)
    }
}
