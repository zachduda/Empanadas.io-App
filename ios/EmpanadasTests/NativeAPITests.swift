import XCTest
@testable import Empanadas

/// Where AccountAPI asks for the native API: /v2/app/, and its old address,
/// /v2/ios/, only of a site from before the move (AccountAPI.sendNative), so
/// a build that reaches the App Store before the site is deployed still works.
/// The same rules as the desktop app's lib/api.js (test/api.test.js).
@MainActor
final class NativeAPITests: XCTestCase {
    private let player = "ab12cd34-0000-1111-2222-333344445555"

    private func site(moved: Bool) -> AccountAPI {
        MovingSite.moved = moved
        MovingSite.asked = []
        return AccountAPI(protocolClasses: [MovingSite.self])
    }

    func testAsksTheNewAddress() async throws {
        let api = site(moved: true)
        let found = try await api.searchPlayers("emp")
        XCTAssertEqual(found.query, "emp")
        XCTAssertEqual(MovingSite.asked, ["/v2/app/search.php"])
    }

    func testFallsBackToTheOldAddressOnASiteFromBeforeTheMove() async throws {
        let api = site(moved: false)
        let found = try await api.searchPlayers("emp")
        XCTAssertEqual(found.query, "emp")
        // The second request goes straight to the old address.
        _ = try await api.searchPlayers("emp", page: 1)
        XCTAssertEqual(MovingSite.asked, ["/v2/app/search.php", "/v2/ios/search.php", "/v2/ios/search.php"])
    }

    func testTheAPIsOwn404IsAnAnswerNotAMissingAddress() async throws {
        let api = site(moved: true)
        do {
            _ = try await api.profile(id: player)
            XCTFail("a player who does not exist was found")
        } catch let error as AccountError {
            XCTAssertEqual(error, .unavailable("not_found"))
        }
        XCTAssertEqual(MovingSite.asked, ["/v2/app/profile.php"], "asked the old address over a real answer")
    }
}

/// The site, from before the move (no /v2/app/: nginx's own 404 page) or
/// after it (both addresses). It answers a player search, and has no player
/// for any profile: the API's own 404.
private final class MovingSite: URLProtocol {
    nonisolated(unsafe) static var moved = false
    nonisolated(unsafe) static var asked: [String] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let path = url.path()
        Self.asked.append(path)
        let isAPI = path.hasPrefix("/v2/ios/") || (Self.moved && path.hasPrefix("/v2/app/"))
        let status: Int
        let body: String
        if !isAPI {
            status = 404
            body = "<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>"
        } else if path.hasSuffix("/profile.php") {
            status = 404
            body = #"{"ok":false,"api":1,"reason":"not_found"}"#
        } else {
            status = 200
            body = #"{"ok":true,"api":1,"query":"emp","page":0,"has_more":false,"results":[]}"#
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": isAPI ? "application/json" : "text/html"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
