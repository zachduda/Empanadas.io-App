import UIKit
import XCTest
@testable import Empanadas

/// The site's look in the app (Features/Shared/Brand.swift).
@MainActor
final class BrandTests: XCTestCase {
    /// Each weight of Poppins the screens ask for is in the app and
    /// registered (UIAppFonts in Info.plist). A name that isn't falls back to
    /// the system font without a word, so nothing else would notice.
    func testPoppinsIsRegistered() {
        for weight in Poppins.allCases {
            XCTAssertNotNil(UIFont(name: weight.rawValue, size: 17), "\(weight.rawValue) isn't registered")
        }
    }
}
