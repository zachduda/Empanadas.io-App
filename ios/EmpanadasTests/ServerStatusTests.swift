import XCTest
@testable import Empanadas

@MainActor
final class ServerStatusTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "ServerStatusTests"

    // Async: a main-actor test case cannot override the synchronous ones.
    override func setUp() async throws {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func makeStatus() -> ServerStatus {
        ServerStatus(defaults: defaults)
    }

    private func level(_ json: String) -> ServerStatus.Level {
        ServerStatus.level(from: Data(json.utf8))
    }

    func testStatuspageIndicators() {
        XCTAssertEqual(level(#"{"status":{"indicator":"none","description":"All Systems Operational"}}"#), .operational)
        XCTAssertEqual(level(#"{"status":{"indicator":"minor"}}"#), .minor)
        XCTAssertEqual(level(#"{"status":{"indicator":"major"}}"#), .major)
        XCTAssertEqual(level(#"{"status":{"indicator":"critical"}}"#), .critical)
    }

    func testDisruptionsAreWarnedAbout() {
        let status = makeStatus()
        XCTAssertNil(status.alertLevel, "not while checking")
        status.update(.operational)
        XCTAssertNil(status.alertLevel)
        status.update(.minor)
        XCTAssertEqual(status.alertLevel, .minor)
        status.update(.major)
        XCTAssertEqual(status.alertLevel, .major)
        status.update(.critical)
        XCTAssertEqual(status.alertLevel, .critical)
        status.update(.unknown)
        XCTAssertNil(status.alertLevel, "no answer is not an outage")
    }

    func testDismissedUntilWorse() {
        let status = makeStatus()
        status.update(.major)
        status.dismissAlert()
        XCTAssertNil(status.alertLevel)
        status.update(.minor)
        XCTAssertNil(status.alertLevel, "better than what was dismissed")
        status.update(.major)
        XCTAssertNil(status.alertLevel, "the same as what was dismissed")
        status.update(.critical)
        XCTAssertEqual(status.alertLevel, .critical)
    }

    func testDismissedUntilFixed() {
        let status = makeStatus()
        status.update(.critical)
        status.dismissAlert()
        status.update(.unknown)
        status.update(.minor)
        XCTAssertNil(status.alertLevel, "not fixed yet, only unheard from")
        status.update(.operational)
        status.update(.minor)
        XCTAssertEqual(status.alertLevel, .minor)
    }

    func testDismissalOutlivesTheApp() {
        let status = makeStatus()
        status.update(.minor)
        status.dismissAlert()

        let relaunched = ServerStatus(defaults: defaults)
        relaunched.update(.minor)
        XCTAssertNil(relaunched.alertLevel)
        relaunched.update(.major)
        XCTAssertEqual(relaunched.alertLevel, .major)
    }

    func testAnythingElseIsUnknown() {
        XCTAssertEqual(level(#"{"status":{"indicator":"maintenance"}}"#), .unknown)
        XCTAssertEqual(level(#"{"status":{}}"#), .unknown)
        XCTAssertEqual(level(#"{}"#), .unknown)
        XCTAssertEqual(level("not json"), .unknown)
    }
}
