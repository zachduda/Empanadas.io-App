import XCTest
@testable import Empanadas

@MainActor
final class ServerStatusTests: XCTestCase {
    private func level(_ json: String) -> ServerStatus.Level {
        ServerStatus.level(from: Data(json.utf8))
    }

    func testStatuspageIndicators() {
        XCTAssertEqual(level(#"{"status":{"indicator":"none","description":"All Systems Operational"}}"#), .operational)
        XCTAssertEqual(level(#"{"status":{"indicator":"minor"}}"#), .minor)
        XCTAssertEqual(level(#"{"status":{"indicator":"major"}}"#), .major)
        XCTAssertEqual(level(#"{"status":{"indicator":"critical"}}"#), .critical)
    }

    func testAnythingElseIsUnknown() {
        XCTAssertEqual(level(#"{"status":{"indicator":"maintenance"}}"#), .unknown)
        XCTAssertEqual(level(#"{"status":{}}"#), .unknown)
        XCTAssertEqual(level(#"{}"#), .unknown)
        XCTAssertEqual(level("not json"), .unknown)
    }
}
