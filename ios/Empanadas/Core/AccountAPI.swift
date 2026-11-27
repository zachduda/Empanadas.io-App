import Foundation
import WebKit

/// The settings the native Settings screen shows. Field names are the ones
/// account_edit.php takes with account_change=settings; values are 0/1, and
/// theme is 0 (match device), 1 (light) or 2 (dark).
struct AccountSettings: Decodable, Equatable {
    var publicaccount: Int
    var starsign: Int
    var allownf: Int
    var analytics: Int
    var theme: Int
    var promoemails: Int
    var otheremails: Int
    var recapemails: Int
    var newsignins: Int
}

/// Who is signed in: the "account" object of /v2/app/account.php
/// (iosAccountProfile() in the site's v2/_lib.php).
struct AccountProfile: Decodable, Equatable {
    var id: Int
    var username: String
    var email: String
    var emailVerified: Bool
    /// An address change waiting on its confirmation link.
    var pendingEmail: String?
    /// The large profile picture, as the site gives it: usually a path.
    var pfp: String?
    var pfpSmall: String?
    var hasCustomPfp: Bool
    var createdAt: String?
    var birthday: String?
    var starSign: String?
    /// Linked sign-in providers, lowercased: "google", "github", "discord".
    var connections: [String]
    var twoFactor: Bool
    var passkeys: Int

    enum CodingKeys: String, CodingKey {
        case id, username, email, pfp, birthday, connections, passkeys
        case emailVerified = "email_verified"
        case pendingEmail = "pending_email"
        case pfpSmall = "pfp_small"
        case hasCustomPfp = "has_custom_pfp"
        case createdAt = "created_at"
        case starSign = "star_sign"
        case twoFactor = "two_factor"
    }

    // Lenient: a field the site adds or drops later must not cost the player
    // the whole Settings screen. Only the name is required.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        username = try c.decode(String.self, forKey: .username)
        id = (try? c.decodeIfPresent(Int.self, forKey: .id)) ?? 0
        email = (try? c.decodeIfPresent(String.self, forKey: .email)) ?? ""
        emailVerified = (try? c.decodeIfPresent(Bool.self, forKey: .emailVerified)) ?? false
        pendingEmail = try? c.decodeIfPresent(String.self, forKey: .pendingEmail)
        pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
        pfpSmall = try? c.decodeIfPresent(String.self, forKey: .pfpSmall)
        hasCustomPfp = (try? c.decodeIfPresent(Bool.self, forKey: .hasCustomPfp)) ?? (pfp != nil)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        birthday = try? c.decodeIfPresent(String.self, forKey: .birthday)
        starSign = try? c.decodeIfPresent(String.self, forKey: .starSign)
        connections = (try? c.decodeIfPresent([String].self, forKey: .connections)) ?? []
        twoFactor = (try? c.decodeIfPresent(Bool.self, forKey: .twoFactor)) ?? false
        passkeys = (try? c.decodeIfPresent(Int.self, forKey: .passkeys)) ?? 0
    }

    init(username: String, email: String, pfp: String?) {
        id = 0
        self.username = username
        self.email = email
        emailVerified = false
        pendingEmail = nil
        self.pfp = pfp
        pfpSmall = pfp
        hasCustomPfp = pfp != nil
        createdAt = nil
        birthday = nil
        starSign = nil
        connections = []
        twoFactor = false
        passkeys = 0
    }
}

/// GET /v2/app/account.php: the account, its settings, and the csrf token that
/// changes to them go back to /v2/account_edit.php with.
///
/// Also reads the older /v2/getdata.php?type=app_settings answer, which has
/// username, email and pfp at the top level instead of an "account" object,
/// for a site that has neither /v2/app/ nor its old address, /v2/ios/.
struct AccountSnapshot: Decodable {
    var account: AccountProfile
    let hasBirthday: Bool
    var settings: AccountSettings
    var csrf: String

    var username: String { account.username }
    var email: String { account.email }

    var pictureURL: URL? {
        account.pfp.flatMap { URL(string: $0, relativeTo: SiteURLs.site)?.absoluteURL }
    }

    enum CodingKeys: String, CodingKey {
        case account, settings, csrf
        case username, email, pfp
        case hasBirthday = "has_birthday"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if c.contains(.account) {
            account = try c.decode(AccountProfile.self, forKey: .account)
        } else {
            account = AccountProfile(
                username: try c.decode(String.self, forKey: .username),
                email: (try? c.decodeIfPresent(String.self, forKey: .email)) ?? "",
                pfp: try? c.decodeIfPresent(String.self, forKey: .pfp)
            )
        }
        hasBirthday = (try? c.decodeIfPresent(Bool.self, forKey: .hasBirthday)) ?? false
        settings = try c.decode(AccountSettings.self, forKey: .settings)
        csrf = try c.decode(String.self, forKey: .csrf)
    }
}

enum AccountError: LocalizedError, Equatable {
    case signedOut
    case needsCaptcha
    case rateLimited
    case staleToken
    /// The site answered, but not with an account. The detail (the site's
    /// reason, or the HTTP status) is shown so a report says what went wrong.
    case unavailable(String)
    case server(String)
    case network

    var errorDescription: String? {
        switch self {
        case .signedOut: "You've been signed out."
        case .needsCaptcha: "Please complete a quick check first."
        case .rateLimited: "That's a lot of changes at once. Try again in a minute."
        case .staleToken: "Your session needs refreshing. Try again."
        case .unavailable(let detail): detail.isEmpty
            ? "Your account couldn't be loaded."
            : "Your account couldn't be loaded (\(detail))."
        case .server(let reason): reason.isEmpty ? "Something went wrong on our end. Try again!" : reason
        case .network: "Couldn't reach Empanadas.io. Check your connection."
        }
    }
}

/// Why /v2/app/signin.php would not sign the app in.
struct SignInError: LocalizedError, Equatable {
    /// The site's reason: "expired" (the code was used, too old, or not for
    /// this request), "deactivated" (the account was deleted meanwhile), or
    /// the HTTP status of an answer that was not the site's JSON.
    let reason: String

    var errorDescription: String? {
        switch reason {
        case "expired": "That sign-in took too long or was already used. Try again."
        case "deactivated": "That account was deleted. Contact us if you'd like it back."
        case "unavailable": "Accounts are switched off right now. Try again later."
        case "rate_limited": "That's a lot of tries. Wait a minute and try again."
        // The detail, so a report says what went wrong.
        default: "Something went wrong on our end (\(reason)). Try again!"
        }
    }
}

/// Native requests to the site, carrying the web views' cookies and user
/// agent so the site sees the same session.
@MainActor
final class AccountAPI {
    private let session: URLSession
    private let cookieStore: WKHTTPCookieStore
    /// This device's message key for the signed-in account, once the site has it.
    private var messageKey: (account: Int, key: MessageCrypto.DeviceKey)?
    /// Each conversation's devices, from its last answer, to seal the next message for.
    private var conversationKeys: [String: MessageKeys] = [:]
    /// Whether each conversation is end-to-end encrypted, from its last answer.
    private var conversationE2ee: [String: Bool] = [:]
    /// Messages already opened, by id and edit.
    private var opened: [String: String] = [:]

    /// `protocolClasses` answer instead of the site: the screenshot tests'
    /// made-up account.
    init(protocolClasses: [AnyClass] = []) {
        let configuration = URLSessionConfiguration.ephemeral
        // Cookies live in WebKit's store, not URLSession's: they are copied in
        // for each request and any the site sets are copied back.
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.protocolClasses = protocolClasses + (configuration.protocolClasses ?? [])
        session = URLSession(configuration: configuration)
        cookieStore = WKWebsiteDataStore.default().httpCookieStore
    }

    /// The signed-in account, from /v2/app/account.php. A good answer is also
    /// kept for offline use (OfflineStore), without its csrf token.
    func snapshot() async throws -> AccountSnapshot {
        let generation = OfflineStore.generation
        let (data, response) = try await sendNative(URLRequest(url: SiteURLs.appAccount))
        let reply = Self.nativeReply(data)

        // A site without the native API at either address: nginx's own 404
        // page, not our JSON.
        if response.statusCode == 404 && reply == nil {
            return try await legacySnapshot()
        }
        let body = try Self.nativeBody(data, reply: reply, status: response.statusCode)
        let snapshot = try Self.decode(AccountSnapshot.self, body)
        remember(snapshot.csrf)
        OfflineStore.save(Self.withoutToken(body), as: .settings, generation: generation)
        return snapshot
    }

    /// GET /v2/app/dashboard.php: everything on the native dashboard.
    func dashboard() async throws -> Dashboard {
        try await nativeGet(SiteURLs.appDashboard, as: Dashboard.self, keep: .dashboard)
    }

    /// GET /v2/app/leaderboard.php: the three boards.
    func leaderboard() async throws -> Leaderboard {
        try await nativeGet(SiteURLs.appLeaderboard, as: Leaderboard.self, keep: .leaderboard)
    }

    // MARK: - Profiles and friends

    /// GET /v2/app/profile.php: a player's profile, or with no id the
    /// player's own, which is also kept for offline use (without its token).
    func profile(id: String? = nil) async throws -> PlayerProfile {
        let generation = OfflineStore.generation
        let (data, response) = try await sendNative(URLRequest(url: SiteURLs.appProfile(id: id)))
        let body = try Self.nativeBody(data, reply: Self.nativeReply(data), status: response.statusCode)
        let profile = try Self.decode(PlayerProfile.self, body)
        remember(profile.csrf)
        if id == nil {
            OfflineStore.save(Self.withoutToken(body), as: .profile, generation: generation)
        }
        return profile
    }

    /// GET /v2/app/search.php: one page of players whose name has `query` in
    /// it. `query` should already be PlayerSearch.term()'s.
    func searchPlayers(_ query: String, page: Int = 0) async throws -> PlayerSearch {
        let (data, response) = try await sendNative(URLRequest(url: SiteURLs.appSearch(query, page: page)))
        let body = try Self.nativeBody(data, reply: Self.nativeReply(data), status: response.statusCode)
        return try Self.decode(PlayerSearch.self, body)
    }

    /// Sends a friend request (account_change=add_friend).
    func addFriend(_ playerID: String) async throws {
        let uuid = try Self.uuidField(playerID)
        try await withToken { csrf in
            try await self.change("add_friend", [("uuid", uuid)], csrf: csrf)
        }
    }

    /// Accepts or declines a request someone sent (account_change=pending_friend).
    func answerFriendRequest(from playerID: String, accept: Bool) async throws {
        let uuid = try Self.uuidField(playerID)
        try await withToken { csrf in
            try await self.change("pending_friend", [("uuid", uuid), ("r", accept ? "1" : "0")], csrf: csrf)
        }
    }

    /// Unfriends a player, or takes back a request sent to them
    /// (account_change=delete_friend removes whatever is between the two).
    func removeFriend(_ playerID: String) async throws {
        let uuid = try Self.uuidField(playerID)
        try await withToken { csrf in
            try await self.change("delete_friend", [("uuid", uuid), ("r", "0")], csrf: csrf)
        }
    }

    /// Changes the player's status line (account_change=bio). The site keeps
    /// it to 200 characters and one line, and only once the address is
    /// verified.
    func updateBio(_ text: String) async throws {
        let line = Self.bioLine(text)
        try await withToken { csrf in
            try await self.change("bio", [("m", line)], csrf: csrf)
        }
    }

    /// One line, as the web's bio box sends it: newlines dropped.
    nonisolated static func bioLine(_ text: String) -> String {
        // By Character: "\r\n" is one line break. components(separatedBy:
        // .newlines) splits it into two scalars and left a double space.
        text.split(whereSeparator: \.isNewline)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
    }

    // MARK: - Messages

    /// GET /v2/app/messages.php: the inbox, newest conversation first, with
    /// each last message opened here for its preview.
    func conversations() async throws -> Inbox {
        let (data, response) = try await sendNative(URLRequest(url: SiteURLs.appMessages))
        var inbox = try Self.decode(Inbox.self, Self.messagesBody(data, status: response.statusCode))
        remember(inbox.csrf)
        var key: MessageCrypto.DeviceKey?
        if inbox.conversations.contains(where: { $0.last.cipher != nil }) { key = try? await ownMessageKey() }
        for index in inbox.conversations.indices {
            let last = inbox.conversations[index].last
            guard !last.deleted, let cipher = last.cipher else { continue }
            if let text = openMessage(cipher, key: key) {
                inbox.conversations[index].last.preview = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            } else {
                inbox.conversations[index].last.preview = "\u{1F512} Encrypted message"
            }
        }
        return inbox
    }

    /// GET /v2/app/messages.php?with=: one conversation, oldest first. With
    /// `after`, only what is newer than that message (an open conversation
    /// asks every few seconds), and with `since` too, what was edited or
    /// deleted since the last answer's `now`; with `before`, the page older.
    func thread(with playerID: String, before: Int? = nil, after: Int? = nil, since: Date? = nil) async throws -> MessageThread {
        let raw = try Self.uuidField(playerID)
        let url = SiteURLs.appMessages(with: playerID, before: before, after: after, since: since)
        let (data, response) = try await sendNative(URLRequest(url: url))
        var thread = try Self.decode(MessageThread.self, Self.messagesBody(data, status: response.statusCode))
        remember(thread.csrf)
        conversationKeys[raw] = thread.keys
        conversationE2ee[raw] = thread.e2ee.on
        // The site didn't list this device among the account's (a registration that failed, or it
        // forgot it): handed over again, so messages are sealed for it.
        if let own = messageKey, !thread.keys.mine.contains(where: { $0.device == own.key.device }) {
            messageKey = nil
            _ = try? await ownMessageKey()
        }
        var key: MessageCrypto.DeviceKey?
        if (thread.messages + thread.changed).contains(where: { $0.cipher != nil }) { key = try? await ownMessageKey() }
        thread.messages = thread.messages.map { reveal($0, key: key) }
        thread.changed = thread.changed.map { reveal($0, key: key) }
        return thread
    }

    /// POST action=send, sealed for both players' devices: the site never
    /// has the words. `nonce` is the message's own id on this device, the
    /// same for every retry of it, so the site stores it once.
    /// `replyTo`: the message it answers.
    func sendMessage(to playerID: String, text: String, nonce: String, replyTo: Int? = nil) async throws -> SentMessage {
        let to = try Self.uuidField(playerID)
        let body = MessageText.cleaned(text)
        guard !body.isEmpty else { throw MessageRefusal(reason: "empty") }
        let nonce = MessageText.isNonce(nonce) ? nonce : MessageText.nonce()
        var fields = [("action", "send"), ("to", to), ("nonce", nonce)]
        if let replyTo, replyTo > 0 { fields.append(("reply_to", String(replyTo))) }
        let reply = try await wordsPost(to, text: body, fields: fields)
        var sent = try Self.decode(SentMessage.self, reply)
        if let cipher = sent.message.cipher {
            opened[cipher] = body
            sent.message = reveal(sent.message, key: nil)
        }
        return sent
    }

    /// POST action=edit: one of the player's own, within a minute of sending.
    /// `encrypted`: it was, so the edit is too, whatever the conversation is now.
    func editMessage(_ messageID: Int, with playerID: String, text: String, encrypted: Bool = false) async throws -> DirectMessage {
        let with = try Self.uuidField(playerID)
        guard messageID > 0 else { throw MessageRefusal(reason: "not_found") }
        let body = MessageText.cleaned(text)
        guard !body.isEmpty else { throw MessageRefusal(reason: "empty") }
        let reply = try await wordsPost(with, text: body, fields: [("action", "edit"), ("message", String(messageID))], seal: encrypted)
        let message = try Self.decode(ChangedMessage.self, reply).message
        guard let cipher = message.cipher else { return message }
        opened[cipher] = body
        return reveal(message, key: nil)
    }

    /// POST action=e2ee: end-to-end encryption on or off, for both of them.
    /// This device's key goes first, so there is one to seal for.
    func setEncrypted(_ on: Bool, with playerID: String) async throws -> ConversationEncryption {
        let with = try Self.uuidField(playerID)
        try await ownMessageKey()
        let reply = try await messagesPost([("action", "e2ee"), ("with", with), ("on", on ? "1" : "0")])
        let e2ee = try Self.decode(EncryptionChange.self, reply).e2ee
        conversationE2ee[with] = e2ee.on
        conversationKeys[with] = nil
        return e2ee
    }

    /// POST action=react: the player's reaction to a message, or "" to take it off.
    func react(to messageID: Int, emoji: String) async throws -> DirectMessage {
        guard messageID > 0 else { throw MessageRefusal(reason: "not_found") }
        let reply = try await messagesPost([("action", "react"), ("message", String(messageID)), ("emoji", emoji)])
        let message = try Self.decode(ChangedMessage.self, reply).message
        guard message.cipher != nil else { return message }
        let key = try? await ownMessageKey()
        return reveal(message, key: key)
    }

    /// POST action=typing: the player is typing to them, or stopped.
    func setTyping(_ on: Bool, to playerID: String) async throws {
        let with = try Self.uuidField(playerID)
        _ = try await messagesPost([("action", "typing"), ("with", with), ("on", on ? "1" : "0")])
    }

    /// POST action=delete: one of the player's own, for both of them.
    func deleteMessage(_ messageID: Int) async throws -> DirectMessage {
        guard messageID > 0 else { throw MessageRefusal(reason: "not_found") }
        let reply = try await messagesPost([("action", "delete"), ("message", String(messageID))])
        return try Self.decode(ChangedMessage.self, reply).message
    }

    /// This device's key, handed to the site once a launch so messages are
    /// sealed for it. Called at sign-in, and before anything is opened.
    @discardableResult
    func ownMessageKey() async throws -> MessageCrypto.DeviceKey {
        if let messageKey { return messageKey.key }
        let account = try await snapshot().account.id
        guard let key = MessageKeychain.key(for: account) else { throw AccountError.unavailable("no message key") }
        _ = try await messagesPost([("action", "register_key"), ("public_key", key.publicKey)])
        messageKey = (account, key)
        return key
    }

    /// Signed out, or someone else in: the last account's key and conversations go.
    func forgetMessages() {
        messageKey = nil
        conversationKeys = [:]
        conversationE2ee = [:]
        opened = [:]
    }

    /// Remembered by the envelope itself: an edit is a new one, and an inbox
    /// row says nothing of edits.
    private func openMessage(_ cipher: String, key: MessageCrypto.DeviceKey?) -> String? {
        if let known = opened[cipher] { return known }
        guard let key, let text = try? MessageCrypto.open(cipher, with: key) else { return nil }
        opened[cipher] = text
        return text
    }

    private func reveal(_ message: DirectMessage, key: MessageCrypto.DeviceKey?) -> DirectMessage {
        var out = message
        guard !out.deleted, let cipher = out.cipher else { return out }
        if let text = openMessage(cipher, key: key) {
            out.text = text
            out.sealed = false
        } else {
            out.text = ""
            out.sealed = true
        }
        return out
    }

    /// Plain text, or once the conversation is encrypted, sealed for both
    /// players' devices and this one. Sealed again if the site says it was
    /// turned on meanwhile, or that a device is new since the last answer.
    /// `seal`: an edit of an encrypted message, sealed whatever the conversation is now.
    private func wordsPost(_ playerID: String, text: String, fields: [(String, String)], seal: Bool = false) async throws -> Data {
        var seal = seal
        if conversationE2ee[playerID] == nil || ((seal || conversationE2ee[playerID] == true) && conversationKeys[playerID] == nil) {
            _ = try await thread(with: playerID, after: Int(Int32.max))
        }
        for _ in 0..<3 {
            var form = fields + [("text", text)]
            if seal || conversationE2ee[playerID] == true {
                let key = try await ownMessageKey()
                let own = MessageKeys.Device(device: key.device, key: key.publicKey)
                let cipher: String
                do {
                    cipher = try MessageCrypto.seal(text, for: (conversationKeys[playerID] ?? MessageKeys()).all + [own])
                } catch {
                    throw MessageRefusal(reason: "no_keys")
                }
                form = fields + [("cipher", cipher)]
            }
            do {
                return try await messagesPost(form)
            } catch let refusal as MessageRefusal
                where (refusal.reason == "keys_changed" || refusal.reason == "encryption_required") && refusal.keys != nil {
                conversationKeys[playerID] = refusal.keys
                if let e2ee = refusal.e2ee { conversationE2ee[playerID] = e2ee.on }
                if refusal.sealed { seal = true }
            }
        }
        throw MessageRefusal(reason: "keys_changed")
    }

    /// POST action=read: what `playerID` sent, up to and including message
    /// `upTo` (all of it without one), is read. Returns the messages still
    /// unread across every conversation, when the site says.
    @discardableResult
    func markMessagesRead(from playerID: String, upTo: Int? = nil) async throws -> Int? {
        let with = try Self.uuidField(playerID)
        var fields = [("action", "read"), ("with", with)]
        if let upTo, upTo > 0 { fields.append(("up_to", String(upTo))) }
        let reply = try await messagesPost(fields)
        return Self.unreadCount(reply)
    }

    /// POST action=block or unblock. Blocking also ends the friendship, and
    /// neither can message the other or send a friend request; they aren't
    /// told. Returns the unread count, when the site says.
    @discardableResult
    func setBlocked(_ playerID: String, _ blocked: Bool) async throws -> Int? {
        let with = try Self.uuidField(playerID)
        let reply = try await messagesPost([("action", blocked ? "block" : "unblock"), ("with", with)])
        return Self.unreadCount(reply)
    }

    /// POST action=report: files a message the player received in the
    /// admin panel's User Feedback.
    /// `text`: an encrypted message as this device opened it, since the site
    /// can't read it.
    func reportMessage(_ messageID: Int, reason: ReportReason, note: String, text: String = "") async throws {
        guard messageID > 0 else { throw MessageRefusal(reason: "not_found") }
        let note = String(MessageText.cleaned(note).prefix(500))
        _ = try await messagesPost([("action", "report"), ("message", String(messageID)),
                                    ("reason", reason.rawValue), ("note", note),
                                    ("text", String(MessageText.cleaned(text).prefix(MessageText.maxLength)))])
    }

    /// One change to messages, with the session's token (and once more with
    /// a fresh one if the site has moved on).
    private func messagesPost(_ fields: [(String, String)]) async throws -> Data {
        try await withToken { csrf in
            var request = URLRequest(url: SiteURLs.appMessages)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Self.formBody(fields + [("csrf", csrf)])
            let (data, response) = try await self.sendNative(request)
            return try Self.messagesBody(data, status: response.statusCode)
        }
    }

    // MARK: - Push notifications

    /// POST /v2/app/push.php action=register: the account's notifications go
    /// to this device (a token another account had here becomes this one's).
    func registerPush(token: String, environment: String) async throws {
        try await withToken { csrf in
            var request = URLRequest(url: SiteURLs.appPush)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Self.formBody([("action", "register"), ("token", token),
                                              ("environment", environment), ("csrf", csrf)])
            let (data, response) = try await self.sendNative(request)
            _ = try Self.messagesBody(data, status: response.statusCode)
        }
    }

    /// POST /v2/app/push.php action=unregister: no more notifications on this
    /// device. Needs no session, so it works after the site has signed out.
    func unregisterPush(token: String) async throws {
        var request = URLRequest(url: SiteURLs.appPush)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.formBody([("action", "unregister"), ("token", token)])
        let (data, response) = try await sendNative(request)
        _ = try Self.messagesBody(data, status: response.statusCode)
    }

    /// The body of a /v2/app/messages.php answer that worked, or the error
    /// it stands for: a MessageRefusal for the reasons the screens explain.
    nonisolated static func messagesBody(_ data: Data, status: Int) throws -> Data {
        let reply = nativeReply(data)
        if status == 429 && reply == nil { throw AccountError.rateLimited }
        guard let reply, !reply.ok, let reason = reply.reason else {
            return try nativeBody(data, reply: reply, status: status)
        }
        switch reason {
        case "no_session": throw AccountError.signedOut
        case "csrf": throw AccountError.staleToken
        case _ where MessageRefusal.reasons.contains(reason):
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let extra = try? JSONDecoder().decode(RefusalKeys.self, from: data)
            throw MessageRefusal(reason: reason, maxLength: intValue(object?["max_length"]) ?? MessageText.maxLength,
                                 keys: extra?.keys, e2ee: extra?.e2ee, sealed: extra?.sealed ?? false)
        default:
            if (500...599).contains(status) { throw AccountError.server(serverErrorMessage(status)) }
            throw AccountError.unavailable(reason)
        }
    }

    nonisolated static func unreadCount(_ data: Data) -> Int? {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return intValue(object?["unread"])
    }

    // MARK: - Feedback

    /// GET /v2/app/feedback.php: the Send Feedback form, with the session's
    /// token. A site without the endpoint yet gets the web form's subjects
    /// (FeedbackForm.builtIn) and a token from the account endpoint.
    ///
    /// The form is kept for a few minutes (CacheAge.feedbackForm), so opening
    /// it again (Report a Problem from a game, then from Settings) asks
    /// nothing: it only changes when the site's subjects or the player's
    /// address do. The token it goes back with is the session's, which a send
    /// renews by itself when the site has moved on (withToken).
    func feedbackForm() async throws -> FeedbackForm {
        if let kept = keptForm, let token, !token.isEmpty,
           Date().timeIntervalSince(kept.at) < CacheAge.feedbackForm {
            var form = kept.form
            form.csrf = token
            return form
        }
        // Signed out while it was on its way: not the next account's form.
        let generation = OfflineStore.generation
        let (data, response) = try await sendNative(URLRequest(url: SiteURLs.appFeedback))
        let reply = Self.nativeReply(data)
        var form: FeedbackForm
        if response.statusCode == 404 && reply == nil {
            form = FeedbackForm.builtIn
            form.csrf = try await snapshot().csrf
        } else {
            let body = try Self.nativeBody(data, reply: reply, status: response.statusCode)
            form = try Self.decode(FeedbackForm.self, body)
            remember(form.csrf)
        }
        if generation == OfflineStore.generation { keptForm = (form, Date()) }
        return form
    }

    /// The Send Feedback form as last read, and when.
    private var keptForm: (form: FeedbackForm, at: Date)?

    /// Sends feedback (account_change=feedback), as the web form's
    /// feedback.js does: the subject's code, the message, and whether a
    /// reply is wanted.
    func sendFeedback(subject: Int, message: String, wantsReply: Bool) async throws {
        let message = FeedbackForm.cleaned(message)
        try await withToken { csrf in
            try await self.change("feedback", [
                ("s", String(subject)),
                ("m", message),
                ("nr", wantsReply ? "1" : "0"),
                ("sso", "0"),
            ], csrf: csrf)
        }
    }

    // MARK: - Daily reward

    /// POST /v2/app/daily.php: claims today's daily reward. A day already
    /// claimed (on the website, another device) is not an error: the answer
    /// pays nothing and carries the reward as it stands.
    func claimDailyReward() async throws -> DailyClaim {
        try await withToken { csrf in
            var request = URLRequest(url: SiteURLs.appDaily)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Self.formBody([("csrf", csrf)])
            let (data, response) = try await self.sendNative(request)
            return try Self.dailyClaimReply(data, status: response.statusCode)
        }
    }

    /// A /v2/app/daily.php answer, or the error it stands for.
    nonisolated static func dailyClaimReply(_ data: Data, status: Int) throws -> DailyClaim {
        let reply = nativeReply(data)
        switch reply?.reason {
        case "csrf": throw AccountError.staleToken
        case "review": throw AccountError.server("This is a demo account for App Review, so rewards aren't saved.")
        case "claimed":
            guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let raw = object["daily"],
                  let json = try? JSONSerialization.data(withJSONObject: raw) else {
                throw AccountError.server("Today's reward is already yours. Come back tomorrow!")
            }
            let daily = try decode(Dashboard.Daily.self, json)
            return DailyClaim(granted: 0, peppers: nil, daily: daily)
        default:
            let body = try nativeBody(data, reply: reply, status: status)
            return try decode(DailyClaim.self, body)
        }
    }

    // MARK: - Updates

    /// GET api.empanadas.io/v1/updates.php: one announcement, the request the
    /// site's Updates page makes (SiteURLs.updatesAPI). Public, so it goes
    /// without the session's cookies, as the site's pages ask for it.
    func announcement(page: Int = 0, id: String? = nil, fresh: Bool = false) async throws -> AnnouncementReply {
        var request = URLRequest(url: SiteURLs.updatesAPI(page: page, post: id, fresh: fresh))
        request.setValue(await WebEnvironment.userAgent(), forHTTPHeaderField: "User-Agent")
        let (data, response) = try await transfer(request)
        guard let http = response as? HTTPURLResponse else { throw AccountError.network }
        guard http.statusCode == 200 else { throw AccountError.unavailable("HTTP \(http.statusCode)") }
        return try Self.decode(AnnouncementReply.self, data)
    }

    // MARK: - Save points

    /// GET /v2/gamehistory.php: the newest save points, or with `before` the
    /// page older than that one, and the account as it is now. The site's
    /// own endpoint for its dashboard's "Manage game data" dialog, rather
    /// than one of /v2/app/: it answers {"result": Bool, "reason": String?}.
    func savePoints(before: Int? = nil) async throws -> SavePointsPage {
        let (data, response) = try await send(URLRequest(url: SiteURLs.gameHistory(before: before)))
        return try Self.decode(SavePointsPage.self, Self.gameHistoryBody(data, status: response.statusCode))
    }

    /// POST /v2/gamehistory.php: puts the account's saves back the way save
    /// point `id` had them. The site first keeps what it replaces as a save
    /// point of its own, so the restore can be undone from the same list.
    func restoreSavePoint(_ id: Int) async throws -> RestoredSave {
        try await withToken { csrf in
            var request = URLRequest(url: SiteURLs.gameHistory)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.httpBody = Self.formBody([("id", String(id)), ("csrf", csrf)])
            let (data, response) = try await self.send(request)
            return try Self.decode(RestoredSave.self, Self.gameHistoryBody(data, status: response.statusCode))
        }
    }

    /// The body of a /v2/gamehistory.php answer that says it worked, or the
    /// error it stands for. Its reasons are the ones the site's dashboard
    /// explains (SavePointsReason).
    nonisolated static func gameHistoryBody(_ data: Data, status: Int) throws -> Data {
        guard let reply = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let result = reply["result"] as? Bool else {
            if status == 429 { throw AccountError.rateLimited }
            if (500...599).contains(status) { throw AccountError.server(serverErrorMessage(status)) }
            // A site without the endpoint yet: nginx's own 404 page.
            throw AccountError.unavailable("HTTP \(status)")
        }
        if result { return data }
        let reason = reply["reason"] as? String ?? ""
        switch reason {
        case "no_session": throw AccountError.signedOut
        case "csrf": throw AccountError.staleToken
        case "cooldown": throw AccountError.server(SavePointsReason.cooldown(intValue(reply["wait"]) ?? 30))
        default: throw AccountError.server(SavePointsReason.message(reason))
        }
    }

    /// The uuid field account_edit.php takes: 32 hex digits, no dashes.
    private nonisolated static func uuidField(_ playerID: String) throws -> String {
        guard let raw = PlayerID.raw(playerID) else { throw AccountError.server("That player couldn't be found.") }
        return raw
    }

    // MARK: - The csrf token

    /// The session's csrf token as the site last handed it out, with an
    /// account or profile answer. One per session: forgotten at sign-out.
    private var token: String?

    private func remember(_ csrf: String) {
        if !csrf.isEmpty { token = csrf }
    }

    /// Deletes the site's cookies (the session, UAK) from WebKit's store,
    /// before a sign-in: the last account's could otherwise ride along with
    /// the new session's, and the site answer for the old account until a
    /// page replaced them. Cloudflare's are kept, they are not the account's.
    /// Local storage is left alone: it holds the games' saves.
    func forgetSession() async {
        token = nil
        keptForm = nil
        forgetMessages()
        for cookie in await cookieStore.allCookies() where Self.isAccountCookie(cookie) {
            await cookieStore.deleteCookie(cookie)
        }
    }

    nonisolated static func isAccountCookie(_ cookie: HTTPCookie) -> Bool {
        let name = cookie.name.lowercased()
        if name.hasPrefix("__cf") || name.hasPrefix("cf_") { return false }
        var domain = cookie.domain.lowercased()
        if domain.hasPrefix(".") { domain.removeFirst() }
        return domain == SiteURLs.appHost || domain.hasSuffix("." + SiteURLs.appHost)
    }

    func forgetToken() {
        token = nil
        keptForm = nil
    }

    /// Runs a change with the session's token: the one last seen, else a
    /// fresh one from /v2/app/account.php. The site clears its token after a
    /// mismatch (when a web page issued a new one meanwhile), so on that the
    /// change is tried once more with a fresh one.
    private func withToken<T: Sendable>(_ body: (String) async throws -> T) async throws -> T {
        let csrf: String
        if let token, !token.isEmpty {
            csrf = token
        } else {
            csrf = try await snapshot().csrf
        }
        do {
            return try await body(csrf)
        } catch AccountError.staleToken {
            token = nil
            let fresh = try await snapshot().csrf
            return try await body(fresh)
        }
    }

    /// One /v2/app/ endpoint, decoded, and kept in OfflineStore when good.
    private func nativeGet<T: Decodable>(_ url: URL, as type: T.Type, keep key: OfflineStore.Key) async throws -> T {
        let generation = OfflineStore.generation
        let (data, response) = try await sendNative(URLRequest(url: url))
        let body = try Self.nativeBody(data, reply: Self.nativeReply(data), status: response.statusCode)
        let value = try Self.decode(T.self, body)
        OfflineStore.save(body, as: key, generation: generation)
        return value
    }

    /// The body of a successful /v2/app/ answer, or the error it stands for.
    /// A 404 that is not our JSON is a site without the endpoint deployed; a
    /// 5xx that is not, the server (or Cloudflare in front of it) failing.
    nonisolated static func nativeBody(_ data: Data, reply: (ok: Bool, reason: String?)?, status: Int) throws -> Data {
        guard let reply else {
            if (500...599).contains(status) { throw AccountError.server(serverErrorMessage(status)) }
            throw AccountError.unavailable("HTTP \(status)")
        }
        if reply.ok { return data }
        switch reply.reason {
        case "no_session": throw AccountError.signedOut
        default: throw AccountError.unavailable(reply.reason ?? "HTTP \(status)")
        }
    }

    nonisolated static func serverErrorMessage(_ status: Int) -> String {
        "Empanadas.io is having trouble right now (error \(status)). Try again in a bit."
    }

    private nonisolated static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AccountError.unavailable("unexpected reply")
        }
    }

    /// The reply with its csrf token blanked: what goes to disk. A token
    /// belongs to the session it was issued in, and a blank one makes
    /// SettingsModel fetch a fresh one before it changes anything.
    nonisolated static func withoutToken(_ data: Data) -> Data {
        guard var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return data }
        if object["csrf"] != nil { object["csrf"] = "" }
        return (try? JSONSerialization.data(withJSONObject: object)) ?? data
    }

    /// The answer every /v2/app/ endpoint gives: {"ok": Bool, "reason": String?}.
    /// Nil when the body is not that (an HTML error page, a proxy's answer).
    nonisolated static func nativeReply(_ data: Data) -> (ok: Bool, reason: String?)? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let ok = object["ok"] as? Bool else { return nil }
        return (ok, object["reason"] as? String)
    }

    /// GET /v2/getdata.php?type=app_settings, which /v2/app/account.php replaced.
    private func legacySnapshot() async throws -> AccountSnapshot {
        let generation = OfflineStore.generation
        let (data, response) = try await send(URLRequest(url: getDataURL("app_settings")))
        let text = plainText(data)
        switch text {
        case "no_session": throw AccountError.signedOut
        case "no_type", "unavailable", "wrong_method": throw AccountError.unavailable(text)
        default: break
        }
        do {
            let snapshot = try JSONDecoder().decode(AccountSnapshot.self, from: data)
            OfflineStore.save(Self.withoutToken(data), as: .settings, generation: generation)
            return snapshot
        } catch {
            throw AccountError.unavailable("HTTP \(response.statusCode)")
        }
    }

    /// One account_change=settings write, as the account page's
    /// bindSettingSelect() sends it.
    func update(_ field: String, to value: Int, csrf: String) async throws {
        try await change("settings", [(field, String(value))], csrf: csrf)
    }

    /// Deletes the account: the same account_edit.php request the account
    /// page's Danger Zone sends. The site checks the typed phrase (DELETE)
    /// itself; the Settings screen asks the player for it.
    func deleteAccount(confirmation: String, csrf: String) async throws {
        try await change("delete_account", [("cp", confirmation)], csrf: csrf)
    }

    /// POST /v2/account_edit.php, the handler behind every change on the
    /// account page (update_account() in the site's accountedit JS).
    private func change(_ action: String, _ fields: [(String, String)], csrf: String) async throws {
        var request = URLRequest(url: SiteURLs.page("/v2/account_edit.php"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.formBody([("account_change", action)] + fields + [("csrf", csrf)])

        let (data, response) = try await send(request)
        if response.statusCode == 429 { throw AccountError.rateLimited }
        guard response.statusCode == 200 else { throw AccountError.server("Error \(response.statusCode)") }

        let reply = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if Self.intValue(reply["result"]) == 1 { return }
        let reason = reply["reason"] as? String ?? ""
        switch reason {
        case "no_session": throw AccountError.signedOut
        case "needs_captcha": throw AccountError.needsCaptcha
        case _ where Self.isStaleToken(reason): throw AccountError.staleToken
        default: throw AccountError.server(Self.stripTags(reason))
        }
    }

    /// account_edit.php says "csrf" when the settings token is stale, and
    /// CSRF_FAIL_MSG ("Your request has expired or was invalid. ...") for
    /// the friend and bio changes.
    nonisolated static func isStaleToken(_ reason: String) -> Bool {
        reason == "csrf" || reason.hasPrefix("Your request has expired or was invalid")
    }

    // MARK: - Signing in

    /// POST /v2/app/signin.php: signs this session (the web views' cookies)
    /// in with the code a sign-in in the browser came back with, and the
    /// verifier of the request it was for (SignInRequest). The site sets the
    /// signed-in session's cookies, which send() copies into WebKit's store.
    ///
    /// Returns the account's username as the site gives it, or nil if the
    /// answer did not include one: what the first dashboard of the session
    /// is checked against (DashboardModel.expect).
    @discardableResult
    func redeemSignIn(code: String, verifier: String) async throws -> String? {
        var request = URLRequest(url: SiteURLs.appSignIn)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.formBody([("code", code), ("verifier", verifier)])

        let (data, response) = try await sendNative(request)
        if response.statusCode == 429 { throw SignInError(reason: "rate_limited") }
        guard let reply = Self.nativeReply(data) else {
            throw SignInError(reason: "HTTP \(response.statusCode)")
        }
        guard reply.ok else { throw SignInError(reason: reply.reason ?? "HTTP \(response.statusCode)") }
        token = nil
        return Self.signedInUsername(data)
    }

    /// account.username from signin.php's answer.
    nonisolated static func signedInUsername(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = object["account"] as? [String: Any],
              let username = account["username"] as? String, !username.isEmpty else { return nil }
        return username
    }

    /// Does the site still consider this session signed in? Nil when it could
    /// not be asked.
    func isSignedIn() async -> Bool? {
        guard let result = try? await send(URLRequest(url: getDataURL("session"))) else { return nil }
        let (data, response) = result
        guard response.statusCode == 200 else { return nil }
        switch plainText(data) {
        case "1": return true
        case "no_session": return false
        default: return nil
        }
    }

    struct Ping { var ok: Bool; var status: Int; var pong: Bool }

    /// Same request as pingSite() in the desktop app.
    func ping() async -> Ping {
        var components = URLComponents(url: SiteURLs.page("/v2/ping.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "usingnativeapp", value: "1"),
            URLQueryItem(name: "_", value: String(Int(Date().timeIntervalSince1970 * 1000))),
        ]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 8
        guard let result = try? await send(request) else {
            return Ping(ok: false, status: 0, pong: false)
        }
        let (data, response) = result
        let ok = (200..<300).contains(response.statusCode)
        return Ping(ok: ok, status: response.statusCode, pong: ok && plainText(data) == "Pong!")
    }

    // MARK: - Plumbing

    private func getDataURL(_ type: String) -> URL {
        var components = URLComponents(url: SiteURLs.page("/v2/getdata.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "type", value: type)]
        return components.url!
    }

    /// Until when the native API's old address is used: set once the site
    /// turned out to be one from before the move.
    private var oldAPIUntil: Date?

    /// How long the old address is used before /v2/app/ is tried again.
    private static let oldAPIRecheck: TimeInterval = 60 * 60

    /// A request to the native API: at /v2/app/, or at its old address,
    /// /v2/ios/, when the site answers /v2/app/ with nginx's own 404 page
    /// rather than our JSON (a site from before the move), and then for
    /// oldAPIRecheck. So the app works whichever of it and the site is updated
    /// first. The API's own 404 ({"ok": false}) is an answer, never retried.
    /// Safe for the sign-in's POST too: an address the site does not have
    /// changed nothing.
    private func sendNative(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url, let oldURL = SiteURLs.oldNativeAPI(url) else {
            return try await send(request)
        }
        var old = request
        old.url = oldURL
        if let until = oldAPIUntil, Date() < until {
            return try await send(old)
        }
        let (data, response) = try await send(request)
        guard response.statusCode == 404, Self.nativeReply(data) == nil else { return (data, response) }
        let (oldData, oldResponse) = try await send(old)
        if oldResponse.statusCode != 404 || Self.nativeReply(oldData) != nil {
            oldAPIUntil = Date().addingTimeInterval(Self.oldAPIRecheck)
        }
        return (oldData, oldResponse)
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url else { throw AccountError.network }
        var request = request
        let cookies = await cookieStore.allCookies().filter { Self.cookie($0, appliesTo: url) }
        for (name, value) in HTTPCookie.requestHeaderFields(with: cookies) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue(await WebEnvironment.userAgent(), forHTTPHeaderField: "User-Agent")

        let (data, response) = try await transfer(request)
        guard let http = response as? HTTPURLResponse else { throw AccountError.network }

        if let fields = http.allHeaderFields as? [String: String], let responseURL = http.url {
            for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: responseURL) {
                await cookieStore.setCookie(cookie)
            }
        }
        return (data, http)
    }

    /// The request itself, tried once more on a failure worth retrying, and
    /// any failure to get an answer as AccountError.network.
    private func transfer(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error where Self.isWorthRetrying(error, request) && !Task.isCancelled {
            // Just after launch, after a while away, the connection is often
            // still coming up (the radio waking, Wi-Fi rejoining, a VPN): the
            // first request fails at once though a moment later it would not.
            try? await Task.sleep(for: .seconds(1.5))
            do {
                return try await session.data(for: request)
            } catch {
                throw AccountError.network
            }
        } catch {
            throw AccountError.network
        }
    }

    /// A failure to try once more: one before the site has answered, on a
    /// request that changes nothing (a change may have reached the site
    /// before the connection dropped). Not a timeout, which has already
    /// waited long enough.
    nonisolated static func isWorthRetrying(_ error: Error, _ request: URLRequest) -> Bool {
        guard (request.httpMethod ?? "GET") == "GET", let error = error as? URLError else { return false }
        return [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
                .cannotFindHost, .dnsLookupFailed, .secureConnectionFailed].contains(error.code)
    }

    nonisolated static func cookie(_ cookie: HTTPCookie, appliesTo url: URL) -> Bool {
        guard let host = url.host(percentEncoded: false)?.lowercased() else { return false }
        if let expires = cookie.expiresDate, expires < Date() { return false }
        if cookie.isSecure && url.scheme?.lowercased() != "https" { return false }

        var domain = cookie.domain.lowercased()
        let hostOnly = !domain.hasPrefix(".")
        if !hostOnly { domain.removeFirst() }
        let domainMatches = hostOnly ? host == domain : (host == domain || host.hasSuffix("." + domain))

        let path = url.path(percentEncoded: true).isEmpty ? "/" : url.path(percentEncoded: true)
        return domainMatches && path.hasPrefix(cookie.path)
    }

    nonisolated static func formBody(_ fields: [(String, String)]) -> Data {
        // ASCII only: CharacterSet.alphanumerics would let "é" through
        // unencoded.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return fields
            .map { name, value in
                let name = name.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                let value = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                return name + "=" + value
            }
            .joined(separator: "&")
            .data(using: .utf8)!
    }

    private func plainText(_ data: Data) -> String {
        String(decoding: data.prefix(64), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }

    /// The site's reasons are written for SweetAlert and may carry <br> and
    /// <b>; the native alert shows plain text.
    nonisolated static func stripTags(_ html: String) -> String {
        html.replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The devices a keys_changed, no_keys or encryption_required refusal names,
/// and with encryption_required, the conversation's encryption now.
private struct RefusalKeys: Decodable {
    var keys: MessageKeys?
    var e2ee: ConversationEncryption?
    var sealed: Bool?
}
