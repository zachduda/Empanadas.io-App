import XCTest
@testable import Empanadas

/// Push notifications: what the app reads from a message's notification (the
/// site's pushMessagePayload() in v2/_push.php, tests/push_test.php there),
/// the device token as the site takes it, and the requests to
/// /v2/app/push.php.
@MainActor
final class PushTests: XCTestCase {
    private let player = "ab12cd34-0000-1111-2222-333344445555"

    /// A notification as the site sends it, as UserNotifications hands over
    /// its userInfo.
    private func userInfo(_ json: String) -> [AnyHashable: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [AnyHashable: Any] ?? [:]
    }

    func testReadsAMessagesNotification() {
        let message = MessageNotification(userInfo: userInfo(#"""
        {"aps":{"alert":{"title":"SpinQueen","body":"race you"},"sound":"default","badge":3,"thread-id":"dm-ab12cd34000011112222333344445555"},
         "dm":{"from":"AB12CD34-0000-1111-2222-333344445555","message":42}}
        """#))
        XCTAssertEqual(message, MessageNotification(from: player, messageID: 42, badge: 3))
    }

    func testANotificationThatIsntAMessagesIsNone() {
        XCTAssertNil(MessageNotification(userInfo: userInfo(#"{"aps":{"alert":"hi"}}"#)))
        XCTAssertNil(MessageNotification(userInfo: userInfo(#"{"dm":{"from":"nobody","message":1}}"#)))
        XCTAssertNil(MessageNotification(userInfo: userInfo(#"{"dm":"x"}"#)))
        XCTAssertNil(MessageNotification(userInfo: [:]))
    }

    func testABadgeIsOptional() {
        let message = MessageNotification(userInfo: userInfo(#"{"aps":{"alert":"x"},"dm":{"from":"ab12cd34000011112222333344445555"}}"#))
        XCTAssertEqual(message?.badge, nil)
        XCTAssertEqual(message?.messageID, 0)
        XCTAssertEqual(message?.from, "ab12cd34000011112222333344445555")
    }

    func testOneConversationIsOneThreadAsTheSiteGroupsIt() {
        XCTAssertEqual(MessageNotification.threadID(for: player), "dm-ab12cd34000011112222333344445555")
        XCTAssertEqual(MessageNotification.threadID(for: player.uppercased()), MessageNotification.threadID(for: player))
    }

    func testATapOpensTheConversation() {
        let message = MessageNotification(from: player, messageID: 1)
        XCTAssertEqual(NativeRoute.messages(message.from), .messages(player))
    }

    func testTheDeviceTokenAsTheSiteTakesIt() {
        XCTAssertEqual(PushToken.hex(Data([0xAB, 0x01, 0x00, 0xFF])), "ab0100ff")
        XCTAssertEqual(PushToken.hex(Data(repeating: 0x12, count: 32)).count, 64)
        #if DEBUG
        XCTAssertEqual(PushToken.environment, "sandbox")
        #else
        XCTAssertEqual(PushToken.environment, "production")
        #endif
    }

    func testRegisteringAndHandingBackADevice() async throws {
        PushSite.posted = []
        let api = AccountAPI(protocolClasses: [PushSite.self])
        // The session's token, as the inbox hands it out.
        _ = try await api.conversations()
        let token = String(repeating: "a1", count: 32)
        try await api.registerPush(token: token, environment: "sandbox")
        try await api.unregisterPush(token: token)
        XCTAssertEqual(PushSite.posted.count, 2)
        XCTAssertEqual(PushSite.posted[0]["action"], "register")
        XCTAssertEqual(PushSite.posted[0]["token"], token)
        XCTAssertEqual(PushSite.posted[0]["environment"], "sandbox")
        XCTAssertEqual(PushSite.posted[0]["csrf"], "account-token", "registering carries the session's token")
        XCTAssertEqual(PushSite.posted[1]["action"], "unregister")
        XCTAssertEqual(PushSite.posted[1]["token"], token)
        XCTAssertNil(PushSite.posted[1]["csrf"], "handing back needs no session, so no token")
    }

    func testARefusedRegistrationIsAnError() async {
        PushSite.posted = []
        let api = AccountAPI(protocolClasses: [PushSite.self])
        do {
            _ = try await api.conversations()
            try await api.registerPush(token: "nope", environment: "production")
            XCTFail("a token the site refused was taken as registered")
        } catch let error as AccountError {
            XCTAssertEqual(error, .unavailable("invalid_token"))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

/// /v2/app/messages.php (for the session's token) and /v2/app/push.php, which
/// refuses anything that isn't a token and records what each POST carried.
private final class PushSite: URLProtocol {
    nonisolated(unsafe) static var posted: [[String: String]] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        var status = 200
        let body: String
        if url.path().hasSuffix("/messages.php") {
            body = #"{"ok":true,"api":1,"conversations":[],"unread":0,"blocked":[],"csrf":"account-token"}"#
        } else {
            let form = Self.form(request)
            Self.posted.append(form)
            if (form["token"] ?? "").count < 64 {
                status = 400
                body = #"{"ok":false,"api":1,"reason":"invalid_token"}"#
            } else {
                body = #"{"ok":true,"api":1,"registered":true,"sending":true}"#
            }
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

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
