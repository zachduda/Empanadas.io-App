import Foundation
import UIKit
import UserNotifications

// Push notifications for direct messages, from the site through Apple's push
// service (the site's v2/_push.php). The app asks the player first (the
// Messages inbox's card, or Settings), then registers with APNs at every
// launch while signed in and hands the site its device token
// (/v2/app/push.php). A notification's tap opens the conversation; one for
// the conversation already on screen isn't shown. At sign-out the token is
// handed back, so the next account on this phone doesn't get the last one's.

/// What a message's notification carries for the app ("dm" beside "aps":
/// pushMessagePayload() in the site's v2/_push.php).
struct MessageNotification: Equatable, Sendable {
    /// The sender's player id.
    let from: String
    let messageID: Int
    /// The unread count the site sent as the badge.
    let badge: Int?

    init(from: String, messageID: Int, badge: Int? = nil) {
        self.from = from
        self.messageID = messageID
        self.badge = badge
    }

    /// Nil for a notification that isn't a message's.
    init?(userInfo: [AnyHashable: Any]) {
        guard let dm = userInfo["dm"] as? [String: Any],
              let from = dm["from"] as? String, PlayerID.isValid(from) else { return nil }
        self.from = from.lowercased()
        messageID = (dm["message"] as? NSNumber)?.intValue ?? 0
        badge = ((userInfo["aps"] as? [String: Any])?["badge"] as? NSNumber)?.intValue
    }

    /// How the site groups one conversation's notifications (thread-id).
    static func threadID(for playerID: String) -> String {
        "dm-" + (PlayerID.raw(playerID) ?? playerID.lowercased())
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

    @ObservationIgnored private var pendingTap: String?
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

    /// The app icon's badge: the messages waiting to be read.
    func setBadge(_ count: Int) {
        guard permission == .on else { return }
        Task { await Self.setBadge(count) }
    }

    /// A conversation is on screen: its notifications have been seen.
    func conversationOpened(with playerID: String) {
        let thread = MessageNotification.threadID(for: playerID)
        Task { await Self.removeDelivered(thread: thread) }
    }

    /// A notification was tapped: its conversation, once the app can show it.
    private func open(_ playerID: String) {
        pendingTap = playerID
        openPending()
    }

    private func openPending() {
        guard let playerID = pendingTap, let app else { return }
        pendingTap = nil
        if let open = app.openConversation, PlayerID.same(open, playerID) { return }
        app.navigate(to: .messages(playerID))
    }

    /// Whether a notification arriving while the app is in front shows: not
    /// for the conversation on screen, which shows the message itself.
    private func presentation(for message: MessageNotification?) -> UNNotificationPresentationOptions {
        guard let message else { return [.banner, .list, .sound] }
        if let badge = message.badge { app?.setUnreadMessages(badge) }
        if let open = app?.openConversation, PlayerID.same(open, message.from) {
            return []
        }
        return [.banner, .list, .sound]
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
}

extension PushNotifications: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let message = MessageNotification(userInfo: notification.request.content.userInfo)
        return await presentation(for: message)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let message = MessageNotification(userInfo: response.notification.request.content.userInfo) else { return }
        await open(message.from)
    }
}
