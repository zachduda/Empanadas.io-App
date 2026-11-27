import CryptoKit
import XCTest
@testable import Empanadas

/// Direct messages: what the app reads from /v2/app/messages.php, what it
/// sends there, the site's reasons for refusing, and the links that open
/// Messages. The same rules as the site's v2/_messages.php
/// (tests/messages_test.php there) and the desktop app's lib/api.js.
@MainActor
final class MessagesTests: XCTestCase {
    private let player = "ab12cd34-0000-1111-2222-333344445555"

    private func json(_ string: String) -> Data { Data(string.utf8) }

    // MARK: - Reading

    func testReadsTheInbox() throws {
        let inbox = try JSONDecoder().decode(Inbox.self, from: json(#"""
        {"ok":true,"api":1,"conversations":[
          {"with":{"id":"ab12cd34-0000-1111-2222-333344445555","username":"SpinQueen","pfp":"/pfp/sm/a.png","default_pfp":false,
                   "relation":"friends","state":"online","label":"Online"},
           "last":{"id":42,"from_me":false,"preview":"race you to 25?","sent":1764147600,"read":false},
           "unread":2,"can_message":true,"reason":null},
          {"with":{"username":"OldFriend","relation":"none","state":null,"label":null},
           "last":{"id":7,"from_me":true,"preview":"gg","sent":1700000000,"read":true},
           "unread":0,"can_message":false,"reason":"not_friends"},
          {"last":{"id":1}}
        ],"unread":2,"blocked":[{"id":"cd34","username":"Meanie"}],"max_length":1000,"csrf":"tok"}
        """#))
        XCTAssertEqual(inbox.conversations.count, 2, "the row without a player is dropped, alone")
        let first = inbox.conversations[0]
        XCTAssertEqual(first.with.username, "SpinQueen")
        XCTAssertEqual(first.with.relation, .friends)
        XCTAssertTrue(first.with.isOnline)
        XCTAssertEqual(first.last.preview, "race you to 25?")
        XCTAssertEqual(first.last.sent, Date(timeIntervalSince1970: 1764147600))
        XCTAssertEqual(first.unread, 2)
        XCTAssertTrue(first.canMessage)
        XCTAssertNil(first.reason)
        XCTAssertEqual(inbox.conversations[1].reason, "not_friends")
        XCTAssertNil(inbox.conversations[1].with.state, "no presence for someone who isn't a friend")
        XCTAssertEqual(inbox.unread, 2)
        XCTAssertEqual(inbox.blocked.map(\.username), ["Meanie"])
        XCTAssertEqual(inbox.csrf, "tok")
    }

    func testReadsAConversation() throws {
        let thread = try JSONDecoder().decode(MessageThread.self, from: json(#"""
        {"ok":true,"api":1,"with":{"id":"x","username":"SpinQueen","relation":"friends"},"can_message":true,"reason":null,
         "blocked":false,"messages":[
           {"id":1,"from_me":true,"text":"hi <b>there</b>\nfriend","sent":1764147600,"read":true},
           {"id":"bad"},
           {"id":2,"from_me":false,"text":"🌮","sent":1764147660,"read":false}
         ],"has_more":true,"seen_up_to":1,"max_length":800,"csrf":"tok"}
        """#))
        XCTAssertEqual(thread.messages.map(\.id), [1, 2], "a malformed message is dropped, alone")
        XCTAssertEqual(thread.messages[0].text, "hi <b>there</b>\nfriend", "kept as typed: drawn as text")
        XCTAssertTrue(thread.messages[0].fromMe)
        XCTAssertTrue(thread.messages[0].read)
        XCTAssertTrue(thread.hasMore)
        XCTAssertEqual(thread.seenUpTo, 1)
        XCTAssertEqual(thread.maxLength, 800)
    }

    func testAConversationFromASiteThatSaysLessStillReads() throws {
        let thread = try JSONDecoder().decode(MessageThread.self, from: json(#"{"with":{"username":"x"}}"#))
        XCTAssertEqual(thread.messages, [])
        XCTAssertFalse(thread.canMessage)
        XCTAssertEqual(thread.maxLength, MessageText.maxLength)
    }

    func testReadsRepliesReactionsTypingAndWhenItWasSeen() throws {
        let thread = try JSONDecoder().decode(MessageThread.self, from: json(#"""
        {"ok":true,"with":{"username":"SpinQueen"},"can_message":true,"messages":[
           {"id":1,"from_me":false,"text":"8pm?","sent":1764147600,"reactions":{"mine":"🔥","theirs":null}},
           {"id":2,"from_me":true,"text":"yes","sent":1764147660,"reply_to":1,"reactions":{"mine":null,"theirs":"❤️"}},
           {"id":3,"from_me":true,"text":"old site","sent":1764147700}
         ],"seen_up_to":2,"seen_at":1764147720,"typing":true,"reactions":["👍","🔥"]}
        """#))
        XCTAssertEqual(thread.messages.map(\.replyTo), [nil, 1, nil])
        XCTAssertEqual(thread.messages[0].reactions, MessageReactions(mine: "🔥"))
        XCTAssertEqual(thread.messages[1].reactions, MessageReactions(theirs: "❤️"))
        XCTAssertTrue(thread.messages[2].reactions.isEmpty, "a message from a site before reactions has none")
        XCTAssertEqual(thread.seenAt, Date(timeIntervalSince1970: 1764147720))
        XCTAssertTrue(thread.typing)
        XCTAssertEqual(thread.reactions, ["👍", "🔥"])
        let bare = try JSONDecoder().decode(MessageThread.self, from: json(#"{"with":{"username":"x"}}"#))
        XCTAssertNil(bare.seenAt)
        XCTAssertFalse(bare.typing)
        XCTAssertEqual(bare.reactions, MessageReactions.all, "the usual reactions until the site says")
    }

    func testDraftsAreKeptByConversationUntilCleared() {
        MessageDrafts.clear()
        defer { MessageDrafts.clear() }
        MessageDrafts.save("half a thought", for: player)
        XCTAssertEqual(MessageDrafts.load(player.uppercased()), "half a thought", "one conversation however its id is written")
        XCTAssertEqual(MessageDrafts.load("cd34cd34000011112222333344445555"), "")
        MessageDrafts.save("  \n ", for: player)
        XCTAssertEqual(MessageDrafts.load(player), "", "an empty box keeps no draft")
        MessageDrafts.save("again", for: player)
        MessageDrafts.clear()
        XCTAssertEqual(MessageDrafts.all(), [:])
    }

    func testTheDashboardCarriesTheUnreadCount() throws {
        let with = try JSONDecoder().decode(Dashboard.self, from: json(#"{"account":{"username":"me"},"messages":{"unread":3}}"#))
        XCTAssertEqual(with.messagesUnread, 3)
        let without = try JSONDecoder().decode(Dashboard.self, from: json(#"{"account":{"username":"me"},"messages":null}"#))
        XCTAssertNil(without.messagesUnread)
        let older = try JSONDecoder().decode(Dashboard.self, from: json(#"{"account":{"username":"me"}}"#))
        XCTAssertNil(older.messagesUnread, "a site from before messages")
    }

    // MARK: - The site's reasons

    private func refusal(_ body: String, status: Int = 403) -> Error? {
        do {
            _ = try AccountAPI.messagesBody(json(body), status: status)
            return nil
        } catch {
            return error
        }
    }

    func testTheSitesReasonsBecomeRefusalsTheScreensExplain() {
        XCTAssertEqual(refusal(#"{"ok":false,"api":1,"reason":"not_friends"}"#) as? MessageRefusal, MessageRefusal(reason: "not_friends"))
        XCTAssertEqual((refusal(#"{"ok":false,"api":1,"reason":"blocked"}"#) as? MessageRefusal)?.reason, "blocked")
        XCTAssertEqual((refusal(#"{"ok":false,"api":1,"reason":"rate_limited"}"#, status: 429) as? MessageRefusal)?.reason, "rate_limited")
        XCTAssertEqual((refusal(#"{"ok":false,"api":1,"reason":"too_long","max_length":1000}"#, status: 400) as? MessageRefusal)?.maxLength, 1000)
        XCTAssertEqual(refusal(#"{"ok":false,"api":1,"reason":"csrf"}"#) as? AccountError, .staleToken)
        XCTAssertEqual(refusal(#"{"ok":false,"api":1,"reason":"no_session"}"#, status: 401) as? AccountError, .signedOut)
        XCTAssertEqual(refusal("<html>Too Many Requests</html>", status: 429) as? AccountError, .rateLimited)
        XCTAssertEqual(refusal("<html>bad gateway</html>", status: 502) as? AccountError,
                       .server(AccountAPI.serverErrorMessage(502)))
        XCTAssertEqual(refusal(#"{"ok":false,"api":1,"reason":"server_error"}"#, status: 500) as? AccountError,
                       .server(AccountAPI.serverErrorMessage(500)))
        XCTAssertNil(refusal(#"{"ok":true,"api":1}"#, status: 200))
    }

    func testWhichRefusalsCloseTheConversation() {
        for reason in ["not_friends", "blocked", "unavailable", "unverified"] {
            XCTAssertTrue(MessageRefusal(reason: reason).closesConversation, reason)
        }
        for reason in ["rate_limited", "too_long", "empty", "keys_changed", "too_late", "no_keys"] {
            XCTAssertFalse(MessageRefusal(reason: reason).closesConversation, reason)
        }
    }

    func testTheWordsForEachReason() {
        XCTAssertEqual(MessageRefusal.text("not_friends", name: "Jeff"), "You can only message friends. Add Jeff as a friend to message them.")
        XCTAssertEqual(MessageRefusal.text("blocked", name: "Jeff"), "You blocked Jeff. Unblock them to send a message.")
        // Whether they blocked you isn't said in so many words.
        XCTAssertEqual(MessageRefusal.text("unavailable", name: "Jeff"), "You can't message Jeff right now.")
        XCTAssertTrue(MessageRefusal.text("too_long", maxLength: 1000).contains("1,000") || MessageRefusal.text("too_long", maxLength: 1000).contains("1000"))
        XCTAssertEqual(MessageRefusal.text(nil), "You can't message them.")
    }

    // MARK: - End-to-end encryption

    /// Sealed by the site's dm_e2ee.js (WebCrypto) for a key made there: the
    /// same envelope opens here with CryptoKit.
    func testOpensWhatTheWebsiteSealed() throws {
        let raw = try XCTUnwrap(Data(base64Encoded: "0dC3WSEjltHRQ0zk/6oLtmGk+WftUG0CDLAEY2of6jw="))
        let key = MessageCrypto.DeviceKey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: raw))
        XCTAssertEqual(key.publicKey, "BJySk2mUFBTAxTG7T3VGkLKLrkMH-O2QMt3InX4vRKwtds6X8VuMXy9hcn8TUN-hvckLnnSr17kdpDvPqI6NNWE")
        XCTAssertEqual(key.device, "5da9260c6a62f8190d3450017166de11")
        let sealed = #"{"v":1,"epk":"BMiicLDXtPKmXckn7VOks_2NxkCfomN42KwCvhb0hboel0MOdcP4t_7Bj5JpkfQaDWdh39r_3DvuXpu_nmGXINo","c":"6MuaFPkJ4HedzgZgArUt30XbFS-EoG_HOTqqFeh338e1cv4v7IM","k":{"5da9260c6a62f8190d3450017166de11":"JOQg8DeSu4KcNsh_cZXSjilz521DQLcqgw7YVe0XHR4ejVkJpyp5--lbieslnqV2pWacymdv1v0MpVZJ"}}"#
        XCTAssertEqual(try MessageCrypto.open(sealed, with: key), "vector ✓")
    }

    func testASealedMessageOpensOnlyOnItsDevices() throws {
        let mine = MessageCrypto.DeviceKey(privateKey: P256.KeyAgreement.PrivateKey())
        let theirs = MessageCrypto.DeviceKey(privateKey: P256.KeyAgreement.PrivateKey())
        let stranger = MessageCrypto.DeviceKey(privateKey: P256.KeyAgreement.PrivateKey())
        let swapped = MessageKeys.Device(device: theirs.device, key: stranger.publicKey)
        let sealed = try MessageCrypto.seal("hola 🌮\nthere", for: [
            MessageKeys.Device(device: mine.device, key: mine.publicKey),
            MessageKeys.Device(device: theirs.device, key: theirs.publicKey),
            swapped,
        ])
        XCTAssertEqual(try MessageCrypto.open(sealed, with: mine), "hola 🌮\nthere")
        XCTAssertEqual(try MessageCrypto.open(sealed, with: theirs), "hola 🌮\nthere")
        XCTAssertThrowsError(try MessageCrypto.open(sealed, with: stranger)) {
            XCTAssertEqual($0 as? MessageCrypto.Failure, .notForDevice, "a key under someone else's id is left out")
        }
        let tampered = sealed.replacingOccurrences(of: #""c":""#, with: #""c":"AAAA"#)
        XCTAssertThrowsError(try MessageCrypto.open(tampered, with: mine)) {
            XCTAssertEqual($0 as? MessageCrypto.Failure, .badPayload)
        }
        XCTAssertThrowsError(try MessageCrypto.seal("nobody", for: [swapped])) {
            XCTAssertEqual($0 as? MessageCrypto.Failure, .noKeys)
        }
    }

    func testReadsEditsDeletesAndKeys() throws {
        let thread = try JSONDecoder().decode(MessageThread.self, from: json(#"""
        {"ok":true,"api":1,"with":{"id":"ab12","username":"Jeff"},"can_message":true,
         "messages":[{"id":1,"from_me":true,"text":"locked","cipher":"{}","sent":100,"edited":130,"deleted":false,"editable_until":160},
                     {"id":2,"from_me":false,"text":"This message was deleted.","cipher":null,"deleted":true}],
         "changed":[{"id":1,"from_me":true,"text":"x","edited":140}],
         "keys":{"mine":[{"device":"aa","key":"bb"}],"theirs":[{"device":"cc","key":"dd"},{"nope":1}]},"e2ee":{"on":true,"by":"them"},"now":150}
        """#))
        XCTAssertEqual(thread.messages[0].edited, Date(timeIntervalSince1970: 130))
        XCTAssertTrue(thread.messages[0].encrypted)
        XCTAssertTrue(thread.messages[0].canEdit(serverNow: Date(timeIntervalSince1970: 159)))
        XCTAssertFalse(thread.messages[0].canEdit(serverNow: Date(timeIntervalSince1970: 160)), "a minute after it was sent")
        XCTAssertEqual(thread.messages[1].shownText, "Message deleted")
        XCTAssertFalse(thread.messages[1].canEdit(serverNow: .distantPast), "not someone else's")
        XCTAssertEqual(thread.changed.map(\.id), [1])
        XCTAssertEqual(thread.keys.all.map(\.device), ["aa", "cc"], "a bad device is dropped, alone")
        XCTAssertEqual(thread.now, Date(timeIntervalSince1970: 150))
        XCTAssertEqual(thread.e2ee, ConversationEncryption(on: true, by: "them"))
        XCTAssertFalse(try JSONDecoder().decode(MessageThread.self, from: json(#"{"with":{"username":"x"}}"#)).e2ee.on,
                       "off until someone turns it on")
        var sealed = thread.messages[0]
        sealed.sealed = true
        XCTAssertEqual(sealed.shownText, "🔒 Can't be read on this device")
        XCTAssertFalse(sealed.canEdit(serverNow: Date(timeIntervalSince1970: 101)), "not one this device can't read")
    }

    func testReadsANoteThatEncryptionWasTurnedOn() throws {
        let thread = try JSONDecoder().decode(MessageThread.self, from: json(#"""
        {"with":{"username":"Jeff"},"messages":[
          {"id":4,"from_me":true,"text":"hi","sent":100,"read":true},
          {"id":5,"from_me":false,"kind":"e2ee_on","text":"🔒 Turned on end-to-end encryption.","sent":110,"read":true}
        ]}
        """#))
        XCTAssertNil(thread.messages[0].kind)
        XCTAssertEqual(thread.messages[1].kind, "e2ee_on")
        var note = thread.messages[1]
        note.editableUntil = .distantFuture
        XCTAssertFalse(note.canEdit(serverNow: .distantPast), "a note isn't a message to edit")
    }

    func testADeletedMessagesSilentNotification() {
        let retraction = MessageRetraction(userInfo: ["aps": ["content-available": 1] as [String: Any],
                                                         "dm": ["retract": 42, "from": "ab12", "badge": 3, "unread": 1] as [String: Any]])
        XCTAssertEqual(retraction?.messageID, 42)
        XCTAssertEqual(retraction?.badge, 3)
        XCTAssertEqual(retraction?.unread, 1)
        XCTAssertNil(MessageRetraction(userInfo: ["dm": ["from": "ab12", "message": 42] as [String: Any]]), "a message's own notification isn't one")
    }

    func testUnsentMessagesAreKeptUntilSentOrDeleted() {
        UnsentMessages.clear()
        defer { UnsentMessages.clear() }
        let first = PendingMessage(nonce: "nonce-unsent1", text: "one", at: Date(timeIntervalSince1970: 100), failed: "Not sent.")
        let second = PendingMessage(nonce: "nonce-unsent2", text: "two", at: Date(timeIntervalSince1970: 200), replyTo: 9)
        UnsentMessages.keep(first, for: player)
        UnsentMessages.keep(second, for: player.uppercased())
        XCTAssertEqual(UnsentMessages.load(player).map(\.text), ["one", "two"], "one conversation however its id is written")
        XCTAssertNil(UnsentMessages.load(player).first?.failed, "tried again, not shown as failed")
        XCTAssertEqual(UnsentMessages.load(player).map(\.replyTo), [nil, 9], "and still answers what it answered")
        XCTAssertEqual(UnsentMessages.load("cd34cd34000011112222333344445555"), [])
        UnsentMessages.drop(first, for: player)
        XCTAssertEqual(UnsentMessages.load(player).map(\.nonce), ["nonce-unsent2"])
        UnsentMessages.clear()
        XCTAssertEqual(UnsentMessages.load(player), [])
    }

    // MARK: - Writing

    func testAMessageIsTidiedAsTheSiteTidiesIt() {
        XCTAssertEqual(MessageText.cleaned("  a\r\nb\rc\t d  \n\n\n\ne  "), "a\nb\nc  d\n\ne")
        XCTAssertEqual(MessageText.cleaned("<b>x</b> & y"), "<b>x</b> & y", "markup is text, kept as typed")
        XCTAssertEqual(MessageText.cleaned(" \n\t "), "")
        // The site counts characters as Unicode scalars (mb_strlen).
        XCTAssertEqual(MessageText.length("👍🏽"), 2)
        XCTAssertEqual(MessageText.length("abc"), 3)
    }

    func testTheDevicesIdForAMessage() {
        let nonce = MessageText.nonce()
        XCTAssertEqual(nonce.count, 32)
        XCTAssertTrue(MessageText.isNonce(nonce))
        XCTAssertNotEqual(nonce, MessageText.nonce())
        XCTAssertTrue(MessageText.isNonce("Ab-_09xy"))
        XCTAssertFalse(MessageText.isNonce("short"))
        XCTAssertFalse(MessageText.isNonce(String(repeating: "a", count: 33)))
        XCTAssertFalse(MessageText.isNonce("has space"))
    }

    func testTheConversationsAddress() {
        let newest = SiteURLs.appMessages(with: player)
        XCTAssertEqual(newest.path(), "/v2/app/messages.php")
        XCTAssertEqual(SiteURLs.queryValue("with", in: newest), "ab12cd34000011112222333344445555")
        XCTAssertNil(SiteURLs.queryValue("before", in: newest))
        let older = SiteURLs.appMessages(with: player, before: 40)
        XCTAssertEqual(SiteURLs.queryValue("before", in: older), "40")
        let poll = SiteURLs.appMessages(with: player, after: 41)
        XCTAssertEqual(SiteURLs.queryValue("after", in: poll), "41")
        XCTAssertNil(SiteURLs.queryValue("since", in: poll))
        let changes = SiteURLs.appMessages(with: player, after: 41, since: Date(timeIntervalSince1970: 1764147600))
        XCTAssertEqual(SiteURLs.queryValue("since", in: changes), "1764147600")
        XCTAssertNil(SiteURLs.queryValue("after", in: SiteURLs.appMessages(with: player, after: 0)))
    }

    // MARK: - Links

    func testLinksThatOpenMessages() {
        let url = { (s: String) in URL(string: s)! }
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/messages")), .messages(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/messages.php?with=" + player.uppercased())), .messages(player))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/messages?with=nobody")), .messages(nil))
        XCTAssertNil(NativeRoute.of(url("https://example.com/v2/messages")))
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://messages")), .messages(nil))
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://messages/" + player.uppercased())), .messages(player))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://messages/nobody")))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://messages/" + player + "/more")))
    }

    // MARK: - Against a site

    func testASendIsSealedAndCarriesItsNonceAndTheToken() async throws {
        MessagesSite.posted = []
        MessageKeychain.inMemory = [:]
        defer { MessageKeychain.inMemory = nil }
        let api = AccountAPI(protocolClasses: [MessagesSite.self])
        let inbox = try await api.conversations()
        XCTAssertEqual(inbox.conversations.count, 0)
        let sent = try await api.sendMessage(to: player, text: "  hey\r\n\r\n\r\nthere  ", nonce: "nonce-abc123")
        XCTAssertEqual(sent.message.text, "hey\n\nthere")
        XCTAssertEqual(MessagesSite.posted.first?["action"], "register_key", "this device's key goes to the site first")
        let form = try XCTUnwrap(MessagesSite.posted.first { $0["action"] == "send" })
        XCTAssertEqual(form["to"], "ab12cd34000011112222333344445555")
        XCTAssertNil(form["text"], "the words never go to the site")
        XCTAssertEqual(form["nonce"], "nonce-abc123")
        XCTAssertEqual(form["csrf"], "inbox-token", "the token the inbox handed out")
        XCTAssertEqual(try MessageCrypto.open(try XCTUnwrap(form["cipher"]), with: MessagesSite.theirs), "hey\n\nthere")
        let own = try await api.ownMessageKey()
        XCTAssertEqual(try MessageCrypto.open(try XCTUnwrap(form["cipher"]), with: own), "hey\n\nthere", "and for this device")

        do {
            _ = try await api.sendMessage(to: player, text: " \n ", nonce: "nonce-abc124")
            XCTFail("an empty message was sent")
        } catch let refusal as MessageRefusal {
            XCTAssertEqual(refusal.reason, "empty")
        }
        XCTAssertEqual(MessagesSite.posted.filter { $0["action"] == "send" }.count, 1, "nothing was sent for it")

        do {
            _ = try await api.sendMessage(to: player, text: "refuse me", nonce: "nonce-abc125")
            XCTFail("a refused message was taken as sent")
        } catch let refusal as MessageRefusal {
            XCTAssertEqual(refusal.reason, "not_friends")
        }
    }
}

/// A site with an empty inbox and one device for the other player, that takes
/// a message unless it says "refuse me" (sealed for that device), and records
/// what each POST carried.
private final class MessagesSite: URLProtocol {
    nonisolated(unsafe) static var posted: [[String: String]] = []
    static let theirs = MessageCrypto.DeviceKey(privateKey: P256.KeyAgreement.PrivateKey())

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        var status = 200
        let body: String
        if url.path().hasSuffix("/account.php") {
            body = #"{"ok":true,"api":1,"account":{"id":4242,"username":"me"},"settings":{"publicaccount":1,"starsign":1,"allownf":1,"analytics":1,"theme":0,"promoemails":0,"otheremails":0,"recapemails":0,"newsignins":1},"csrf":"inbox-token"}"#
        } else if request.httpMethod == "POST" {
            let form = Self.form(request)
            Self.posted.append(form)
            let opened = (form["cipher"]).flatMap { try? MessageCrypto.open($0, with: Self.theirs) }
            if form["action"] == "register_key" {
                body = #"{"ok":true,"api":1,"device":"x"}"#
            } else if opened == "refuse me" {
                status = 403
                body = #"{"ok":false,"api":1,"reason":"not_friends"}"#
            } else {
                body = #"{"ok":true,"api":1,"message":{"id":9,"from_me":true,"text":"locked","cipher":"{}","sent":1764147600,"read":false},"duplicate":false}"#
            }
        } else if SiteURLs.queryValue("with", in: url) != nil {
            body = #"{"ok":true,"api":1,"with":{"id":"ab12","username":"Jeff"},"messages":[],"keys":{"mine":[],"theirs":[{"device":""# + Self.theirs.device + #"","key":""# + Self.theirs.publicKey + #""}]},"e2ee":{"on":true,"by":"them"},"now":1764147600,"csrf":"inbox-token"}"#
        } else {
            body = #"{"ok":true,"api":1,"conversations":[],"unread":0,"blocked":[],"max_length":1000,"csrf":"inbox-token"}"#
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// The form a request carried. URLSession hands a protocol the body as a
    /// stream, not as httpBody.
    private static func form(_ request: URLRequest) -> [String: String] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
        }
        var components = URLComponents()
        components.percentEncodedQuery = String(decoding: data, as: UTF8.self)
        var out: [String: String] = [:]
        for item in components.queryItems ?? [] { out[item.name] = item.value ?? "" }
        return out
    }
}
