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
        for reason in ["rate_limited", "too_long", "empty"] {
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

    func testASendCarriesItsNonceAndTheToken() async throws {
        MessagesSite.posted = []
        let api = AccountAPI(protocolClasses: [MessagesSite.self])
        let inbox = try await api.conversations()
        XCTAssertEqual(inbox.conversations.count, 0)
        let sent = try await api.sendMessage(to: player, text: "  hey\r\n\r\n\r\nthere  ", nonce: "nonce-abc123")
        XCTAssertEqual(sent.message.text, "hey\n\nthere")
        let form = try XCTUnwrap(MessagesSite.posted.first)
        XCTAssertEqual(form["action"], "send")
        XCTAssertEqual(form["to"], "ab12cd34000011112222333344445555")
        XCTAssertEqual(form["text"], "hey\n\nthere")
        XCTAssertEqual(form["nonce"], "nonce-abc123")
        XCTAssertEqual(form["csrf"], "inbox-token", "the token the inbox handed out")

        do {
            _ = try await api.sendMessage(to: player, text: " \n ", nonce: "nonce-abc124")
            XCTFail("an empty message was sent")
        } catch let refusal as MessageRefusal {
            XCTAssertEqual(refusal.reason, "empty")
        }
        XCTAssertEqual(MessagesSite.posted.count, 1, "nothing was sent for it")

        do {
            _ = try await api.sendMessage(to: player, text: "refuse me", nonce: "nonce-abc125")
            XCTFail("a refused message was taken as sent")
        } catch let refusal as MessageRefusal {
            XCTAssertEqual(refusal.reason, "not_friends")
        }
    }
}

/// A site with an empty inbox that takes a message unless it says "refuse
/// me", and records what each POST carried.
private final class MessagesSite: URLProtocol {
    nonisolated(unsafe) static var posted: [[String: String]] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        var status = 200
        let body: String
        if request.httpMethod == "POST" {
            let form = Self.form(request)
            Self.posted.append(form)
            if form["text"] == "refuse me" {
                status = 403
                body = #"{"ok":false,"api":1,"reason":"not_friends"}"#
            } else {
                let text = (form["text"] ?? "").replacingOccurrences(of: "\n", with: "\\n")
                body = #"{"ok":true,"api":1,"message":{"id":9,"from_me":true,"text":""# + text + #"","sent":1764147600,"read":false},"duplicate":false}"#
            }
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
