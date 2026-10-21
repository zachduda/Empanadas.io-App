import SwiftUI
import XCTest
@testable import Empanadas

/// The slides between the tabs (App/TabSlides.swift), on a TabView like the
/// app's: four tabs, each a navigation stack. No touch can be made here, so a
/// swipe goes through the steps the pan takes: begin, follow, let go.
@MainActor
final class TabSlidesTests: XCTestCase {
    private var windows: [UIWindow] = []

    override func tearDown() async throws {
        for window in windows {
            window.isHidden = true
            window.rootViewController = nil
        }
        windows = []
    }

    func testStandsInAsTheDelegateAndPassesTheRestOn() async throws {
        // What SwiftUI's own delegate answers, without the slides.
        let plain = try await show(Tabs(selection: Selection(), slides: false))
        let swiftUIs = try XCTUnwrap(plain.delegate)
        let answered = Self.delegateSelectors.filter { swiftUIs.responds(to: $0) }
        XCTAssertFalse(answered.isEmpty)

        let controller = try await show(Tabs(selection: Selection()))
        let delegate = try XCTUnwrap(controller.delegate)
        for selector in answered {
            XCTAssertTrue(delegate.responds(to: selector), "\(selector)")
        }
        let tabs = try XCTUnwrap(controller.viewControllers)
        XCTAssertEqual(tabs.count, 4)
        XCTAssertNotNil(delegate.tabBarController?(controller, animationControllerForTransitionFrom: tabs[0], to: tabs[1]))
    }

    func testTheTabViewsOwnChangesSlide() async throws {
        // A deep link, or Home's "Play a Game": the selection changes, and the
        // controller follows it with a transition rather than at once.
        let selection = Selection()
        let controller = try await show(Tabs(selection: selection))
        selection.tab = 2
        try await waitFor { controller.selectedIndex == 2 }
        XCTAssertNotNil(controller.transitionCoordinator)
        try await settle()
        XCTAssertNil(controller.transitionCoordinator)
        XCTAssertEqual(controller.selectedIndex, 2)
    }

    func testASwipePastTheMiddleChangesTab() async throws {
        let selection = Selection()
        let controller = try await show(Tabs(selection: selection))
        let swipe = TabSwipe.attach(to: controller)
        XCTAssertTrue(swipe.canBegin(towards: -1))
        XCTAssertFalse(swipe.canBegin(towards: 1), "Nothing on the left of the first tab")

        swipe.begin(to: 1)
        XCTAssertEqual(selection.tab, 1, "The TabView hears of it at once")
        swipe.follow(-100, width: 390)
        // Something else changes meanwhile, as the dashboard might: the
        // TabView updates, and must not put the old tab back.
        selection.unrelated += 1
        try await Task.sleep(for: .seconds(0.2))
        XCTAssertNotNil(controller.transitionCoordinator, "Still following the finger")
        XCTAssertFalse(swipe.canBegin(towards: -1), "One swipe at a time")
        swipe.follow(-250, width: 390)
        swipe.letGo(at: -250, speed: -100, width: 390, cancelled: false)
        try await settle()

        XCTAssertEqual(controller.selectedIndex, 1)
        XCTAssertEqual(selection.tab, 1)
        XCTAssertTrue(swipe.canBegin(towards: 1), "And back again")
        XCTAssertTrue(swipe.canBegin(towards: -1))
    }

    func testASwipeLetGoShortOfTheMiddleGoesBack() async throws {
        let selection = Selection()
        let controller = try await show(Tabs(selection: selection))
        let swipe = TabSwipe.attach(to: controller)

        swipe.begin(to: 1)
        swipe.follow(-120, width: 390)
        try await Task.sleep(for: .seconds(0.1))
        swipe.letGo(at: -120, speed: 0, width: 390, cancelled: false)
        try await settle()

        XCTAssertEqual(controller.selectedIndex, 0)
        XCTAssertEqual(selection.tab, 0)
    }

    func testAFlickChangesTabFromAShortWayAcross() async throws {
        let selection = Selection()
        let controller = try await show(Tabs(selection: selection))
        let swipe = TabSwipe.attach(to: controller)

        swipe.begin(to: 1)
        swipe.follow(-50, width: 390)
        swipe.letGo(at: -50, speed: -1500, width: 390, cancelled: false)
        try await settle()

        XCTAssertEqual(controller.selectedIndex, 1)
        XCTAssertEqual(selection.tab, 1)
    }

    func testASwipeTheSystemTakesGoesBack() async throws {
        let selection = Selection()
        let controller = try await show(Tabs(selection: selection))
        let swipe = TabSwipe.attach(to: controller)

        swipe.begin(to: 1)
        swipe.follow(-300, width: 390)
        swipe.letGo(at: -300, speed: -800, width: 390, cancelled: true)
        try await settle()

        XCTAssertEqual(controller.selectedIndex, 0)
        XCTAssertEqual(selection.tab, 0)
    }

    func testNoSwipeOnAScreenPushedOnATab() async throws {
        let selection = Selection()
        let controller = try await show(Tabs(selection: selection))
        let swipe = TabSwipe.attach(to: controller)

        selection.path.append(1)
        try await settle()
        XCTAssertFalse(swipe.canBegin(towards: -1), "A swipe from the edge goes back instead")

        selection.path = NavigationPath()
        try await settle()
        XCTAssertTrue(swipe.canBegin(towards: -1))
    }

    // MARK: - Helpers

    /// What a tab bar controller's delegate can be asked, besides the
    /// transitions.
    private static let delegateSelectors = [
        "tabBarController:shouldSelectViewController:",
        "tabBarController:didSelectViewController:",
        "tabBarController:shouldSelectTab:",
        "tabBarController:didSelectTab:previousTab:",
        "tabBarController:visibilityDidChangeForTabs:",
        "tabBarController:displayOrderDidChangeForGroup:",
        "tabBarControllerSupportedInterfaceOrientations:",
    ].map(NSSelectorFromString)

    private func show(_ tabs: Tabs) async throws -> UITabBarController {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let host = UIHostingController(rootView: tabs)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.isHidden = false
        windows.append(window)
        try await Task.sleep(for: .seconds(0.5))
        return try XCTUnwrap(Self.tabBarController(in: host))
    }

    private static func tabBarController(in controller: UIViewController) -> UITabBarController? {
        if let tabs = controller as? UITabBarController { return tabs }
        for child in controller.children {
            if let tabs = tabBarController(in: child) { return tabs }
        }
        return nil
    }

    /// Long enough for any slide to have finished.
    private func settle() async throws {
        try await Task.sleep(for: .seconds(0.8))
    }

    /// Checks every 10 milliseconds, for up to a second.
    private func waitFor(_ condition: () -> Bool) async throws {
        var tries = 0
        while !condition(), tries < 100 {
            try await Task.sleep(for: .milliseconds(10))
            tries += 1
        }
        XCTAssertTrue(condition())
    }
}

@MainActor
@Observable
private final class Selection {
    var tab = 0
    var unrelated = 0
    /// The first tab's navigation stack.
    var path = NavigationPath()
}

private struct Tabs: View {
    let selection: Selection
    var slides = true

    var body: some View {
        @Bindable var selection = selection

        TabView(selection: $selection.tab) {
            ForEach(0..<4) { index in
                Group {
                    if slides {
                        screen(index)
                            .slidesBetweenTabs(Array(0..<4), selection: $selection.tab)
                    } else {
                        screen(index)
                    }
                }
                .tabItem { Label("Tab \(index)", systemImage: "star.fill") }
                .tag(index)
            }
        }
    }

    private func screen(_ index: Int) -> some View {
        @Bindable var selection = selection

        return NavigationStack(path: index == 0 ? $selection.path : .constant(NavigationPath())) {
            List { Text("Tab \(index), \(selection.unrelated)") }
                .navigationTitle("Tab \(index)")
                .navigationDestination(for: Int.self) { Text("Pushed \($0)") }
        }
    }
}
