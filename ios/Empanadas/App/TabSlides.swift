import SwiftUI
import UIKit

// Moving between the tabs slides them, as pages side by side: a tap on the tab
// bar, the app's own changes of tab (a deep link, Home's "Play a Game"), and a
// sideways swipe anywhere on a tab's first screen, which follows the finger to
// the tab beside it.
//
// The tab bar stays the system's: SwiftUI's TabView, on UIKit's tab bar
// controller. This gives that controller the transition, the way UIKit has a
// tab bar controller's delegate supply one, and the pan that drives it.

extension View {
    /// On each tab's content in the TabView: `tabs` in the TabView's order,
    /// and its selection, which a swipe brings up to date (it changes the tab
    /// from UIKit's side).
    func slidesBetweenTabs<Tab: Hashable>(_ tabs: [Tab], selection: Binding<Tab>) -> some View {
        background(TabSlidesHook(tabs: tabs, selection: selection))
    }

    /// A sideways drag that starts here stays this view's own, rather than
    /// changing tab: the Spin chart's drag to read a day.
    func keepsSidewaysDrags() -> some View {
        background(SidewaysDragMarker())
    }
}

/// Finds the tab bar controller its tab is in, and gives it the slides.
private struct TabSlidesHook<Tab: Hashable>: UIViewRepresentable {
    let tabs: [Tab]
    let selection: Binding<Tab>

    func makeUIView(context: Context) -> TabSlidesHookView {
        let view = TabSlidesHookView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: TabSlidesHookView, context: Context) {
        let tabs = tabs
        let selection = selection
        view.select = { index in
            guard tabs.indices.contains(index), selection.wrappedValue != tabs[index] else { return }
            selection.wrappedValue = tabs[index]
        }
        view.attach()
    }
}

private final class TabSlidesHookView: UIView {
    var select: (@MainActor (Int) -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        attach()
    }

    func attach() {
        guard window != nil,
              let controller = sequence(first: self as UIResponder, next: { $0.next })
                .first(where: { $0 is UITabBarController }) as? UITabBarController
        else { return }
        TabSwipe.attach(to: controller).select = select
    }
}

private struct SidewaysDragMarker: UIViewRepresentable {
    func makeUIView(context: Context) -> SidewaysDragMarkerView {
        let view = SidewaysDragMarkerView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: SidewaysDragMarkerView, context: Context) {}
}

private final class SidewaysDragMarkerView: UIView {
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            TabSwipe.markers.add(self)
        } else {
            TabSwipe.markers.remove(self)
        }
    }
}

// MARK: - The swipe

/// The pan across a tab bar controller's view, and the slides between its
/// tabs, the tab bar's own and the swipe's alike. One for each controller.
@MainActor
final class TabSwipe: NSObject, UIGestureRecognizerDelegate {
    /// Where a sideways drag is left alone (keepsSidewaysDrags).
    fileprivate static let markers = NSHashTable<UIView>.weakObjects()

    /// The controller's, made the first time.
    static func attach(to controller: UITabBarController) -> TabSwipe {
        if let swipe = controller.view.gestureRecognizers?.lazy.compactMap({ ($0 as? Pan)?.swipe }).first {
            swipe.claimDelegate()
            return swipe
        }
        return TabSwipe(controller)
    }

    /// Tells the TabView which tab is showing, by its place in the tab bar.
    var select: (@MainActor (Int) -> Void)?

    private weak var controller: UITabBarController?
    private weak var pan: Pan?
    private let transitions = Transitions()
    /// The slide under way, if any.
    private var slide: Slide?
    /// A finger is down, and the slide it starts is its to follow.
    private var isSwiping = false
    /// The swipe's hold on the slide.
    private var interaction: SwipeInteraction?

    private init(_ controller: UITabBarController) {
        self.controller = controller
        super.init()
        transitions.swipe = self
        claimDelegate()

        // On the controller's view, which keeps it, and so this, as long as
        // the controller lasts.
        let pan = Pan(target: self, action: #selector(swiped(_:)))
        pan.swipe = self
        pan.delegate = self
        // A Mac's pointer drags rather than swipes, and a trackpad's sideways
        // scroll is no pan: there the tab bar's taps slide, and that is all.
        pan.isEnabled = !ProcessInfo.processInfo.isiOSAppOnMac
        controller.view.addGestureRecognizer(pan)
        self.pan = pan
    }

    /// Stands in as the controller's delegate. SwiftUI's own, which follows
    /// the taps on the tab bar (and a second tap on the tab showing), still
    /// hears everything else.
    private func claimDelegate() {
        guard let controller, controller.delegate !== transitions else { return }
        transitions.forward = controller.delegate
        controller.delegate = transitions
    }

    // MARK: Transitions

    fileprivate func animator(from: UIViewController, to: UIViewController) -> Slide? {
        guard let controller, let tabs = controller.viewControllers,
              let start = tabs.firstIndex(of: from), let end = tabs.firstIndex(of: to), start != end
        else { return nil }
        let slide = Slide(entersFromRight: (end > start) != isRightToLeft,
                          fades: UIAccessibility.isReduceMotionEnabled)
        slide.ended = { [weak self, weak slide] in
            guard let self, let slide, self.slide === slide else { return }
            self.slide = nil
            self.interaction = nil
            if let controller = self.controller { self.select?(controller.selectedIndex) }
        }
        self.slide = slide
        return slide
    }

    fileprivate func interaction(for animator: any UIViewControllerAnimatedTransitioning)
        -> (any UIViewControllerInteractiveTransitioning)? {
        guard isSwiping, interaction == nil, let slide = animator as? Slide, slide === self.slide else { return nil }
        let interaction = SwipeInteraction(slide: slide)
        self.interaction = interaction
        return interaction
    }

    // MARK: The pan

    @objc private func swiped(_ pan: UIPanGestureRecognizer) {
        guard let view = controller?.view else { return }
        let width = view.bounds.width
        let x = pan.translation(in: view).x
        switch pan.state {
        case .began:
            if let target = neighbour(towards: pan.velocity(in: view).x) { begin(to: target) }
        case .changed:
            follow(x, width: width)
        case .ended, .cancelled, .failed:
            letGo(at: x, speed: pan.velocity(in: view).x, width: width, cancelled: pan.state != .ended)
        default:
            break
        }
    }

    /// Whether a swipe this way (the sign of `x`: left is negative) can start
    /// now: there is a tab that side, and the one showing is on its first
    /// screen, with nothing presented over it and no change of tab under way.
    func canBegin(towards x: CGFloat) -> Bool {
        guard let controller, controller.transitionCoordinator == nil, controller.presentedViewController == nil,
              neighbour(towards: x) != nil
        else { return false }
        return isOnFirstScreen(controller.selectedViewController)
    }

    /// The finger is down: the tab at `target` starts on its way in.
    func begin(to target: Int) {
        guard let controller else { return }
        isSwiping = true
        interaction = nil
        controller.selectedIndex = target
        // At once, not when the slide ends: SwiftUI doesn't hear of a change
        // made from UIKit's side, and until its selection says the same, any
        // update of the TabView would put the old tab back, in the middle of
        // the slide.
        select?(controller.selectedIndex)
    }

    /// The finger is `x` points across from where it went down, on a view
    /// `width` across.
    func follow(_ x: CGFloat, width: CGFloat) {
        guard let interaction else { return }
        interaction.update(progress(of: interaction.slide, x, width: width))
    }

    /// The finger came up `x` across, moving at `speed` (points a second, left
    /// negative), or the system took the touch (`cancelled`). Past the middle,
    /// or short of it but flicked, the new tab comes the rest of the way;
    /// otherwise the old one goes back.
    func letGo(at x: CGFloat, speed: CGFloat, width: CGFloat, cancelled: Bool) {
        isSwiping = false
        guard let interaction else { return }
        let width = max(width, 1)
        let speed = along(interaction.slide, speed)
        // Where the slide would come to rest if let go at this speed.
        let projected = progress(of: interaction.slide, x, width: width) + speed * 0.15 / width
        interaction.end(finishing: !cancelled && projected > 0.5, speed: speed, distance: width)
    }

    private var isRightToLeft: Bool {
        controller?.view.effectiveUserInterfaceLayoutDirection == .rightToLeft
    }

    /// Movement in the direction the slide goes, towards its end.
    private func along(_ slide: Slide, _ x: CGFloat) -> CGFloat {
        slide.entersFromRight ? -x : x
    }

    private func progress(of slide: Slide, _ x: CGFloat, width: CGFloat) -> CGFloat {
        min(max(along(slide, x) / max(width, 1), 0), 1)
    }

    /// The tab a swipe this way brings in: a swipe to the left, the one on
    /// the right of the one showing. Nil past the first and the last.
    private func neighbour(towards x: CGFloat) -> Int? {
        guard let controller, let count = controller.viewControllers?.count, x != 0 else { return nil }
        let current = controller.selectedIndex
        guard current < count else { return nil }
        let target = current + ((x < 0) != isRightToLeft ? 1 : -1)
        return (0..<count).contains(target) ? target : nil
    }

    /// Nothing pushed on the tab's navigation stack: further in, a swipe from
    /// the left edge goes back instead.
    private func isOnFirstScreen(_ tab: UIViewController?) -> Bool {
        guard let tab else { return false }
        guard let navigation = Self.navigationController(in: tab) else { return true }
        return navigation.viewControllers.count <= 1 && navigation.transitionCoordinator == nil
    }

    private static func navigationController(in controller: UIViewController) -> UINavigationController? {
        if let navigation = controller as? UINavigationController { return navigation }
        for child in controller.children {
            if let navigation = navigationController(in: child) { return navigation }
        }
        return nil
    }

    // MARK: UIGestureRecognizerDelegate

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let pan, recognizer === pan, let view = controller?.view else { return false }
        let velocity = pan.velocity(in: view)
        // Clearly sideways: anything nearer up or down is a scroll.
        return abs(velocity.x) > abs(velocity.y) * 1.5 && canBegin(towards: velocity.x)
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let controller, let touched = touch.view else { return true }
        // The tab bar's own drag from tab to tab; a switch, a segmented
        // control or a slider; a row that scrolls sideways.
        for view in sequence(first: touched, next: { $0.superview }) {
            if view === controller.view { break }
            if view === controller.tabBar || view is UIControl { return false }
            if let scrollView = view as? UIScrollView, scrollView.scrollsSideways { return false }
        }
        return !Self.markers.allObjects.contains { marker in
            marker.window === touched.window && marker.bounds.contains(touch.location(in: marker))
        }
    }
}

/// The swipe's pan, which keeps the swipe.
private final class Pan: UIPanGestureRecognizer {
    var swipe: TabSwipe?
}

private extension UIScrollView {
    /// Wider than it is, so a sideways drag scrolls it.
    var scrollsSideways: Bool {
        isScrollEnabled && contentSize.width + adjustedContentInset.left + adjustedContentInset.right > bounds.width + 1
    }
}

// MARK: - The controller's delegate

/// Supplies the slide, and the swipe's hold on it, and passes everything else
/// on to the delegate it stands in for.
private final class Transitions: NSObject, UITabBarControllerDelegate {
    weak var swipe: TabSwipe?
    nonisolated(unsafe) weak var forward: (any UITabBarControllerDelegate)?

    nonisolated override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || (forward?.responds(to: selector) ?? false)
    }

    nonisolated override func forwardingTarget(for selector: Selector!) -> Any? {
        if let forward, forward.responds(to: selector) { return forward }
        return super.forwardingTarget(for: selector)
    }

    func tabBarController(_ tabBarController: UITabBarController,
                          animationControllerForTransitionFrom fromVC: UIViewController,
                          to toVC: UIViewController) -> (any UIViewControllerAnimatedTransitioning)? {
        if let slide = swipe?.animator(from: fromVC, to: toVC) { return slide }
        return forward?.tabBarController?(tabBarController, animationControllerForTransitionFrom: fromVC, to: toVC)
    }

    func tabBarController(_ tabBarController: UITabBarController,
                          interactionControllerFor animationController: any UIViewControllerAnimatedTransitioning)
        -> (any UIViewControllerInteractiveTransitioning)? {
        if let interaction = swipe?.interaction(for: animationController) { return interaction }
        return forward?.tabBarController?(tabBarController, interactionControllerFor: animationController)
    }
}

// MARK: - The slide

/// Both tabs move together, the one coming in from its side of the one
/// going; with Reduce Motion, a fade instead.
private final class Slide: NSObject, UIViewControllerAnimatedTransitioning {
    static let duration: TimeInterval = 0.32

    let entersFromRight: Bool
    let fades: Bool
    var ended: (@MainActor () -> Void)?
    private var animator: UIViewPropertyAnimator?
    private var context: (any UIViewControllerContextTransitioning)?

    init(entersFromRight: Bool, fades: Bool) {
        self.entersFromRight = entersFromRight
        self.fades = fades
        super.init()
    }

    func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval {
        Self.duration
    }

    func animateTransition(using context: any UIViewControllerContextTransitioning) {
        propertyAnimator(using: context).startAnimation()
    }

    func interruptibleAnimator(using context: any UIViewControllerContextTransitioning) -> any UIViewImplicitlyAnimating {
        propertyAnimator(using: context)
    }

    func animationEnded(_ transitionCompleted: Bool) {
        ended?()
    }

    func propertyAnimator(using context: any UIViewControllerContextTransitioning) -> UIViewPropertyAnimator {
        if let animator { return animator }
        let animator = UIViewPropertyAnimator(duration: Self.duration, dampingRatio: 1)
        self.animator = animator
        self.context = context

        guard let from = context.view(forKey: .from), let to = context.view(forKey: .to),
              let toController = context.viewController(forKey: .to)
        else {
            animator.addAnimations {}
            animator.addCompletion { [self] _ in complete(removing: nil) }
            return animator
        }
        let container = context.containerView
        to.frame = context.finalFrame(for: toController)
        container.addSubview(to)
        let shift = entersFromRight ? container.bounds.width : -container.bounds.width
        let fades = fades
        if fades {
            to.alpha = 0
        } else {
            to.transform = CGAffineTransform(translationX: shift, y: 0)
        }
        animator.addAnimations {
            if fades {
                from.alpha = 0
                to.alpha = 1
            } else {
                from.transform = CGAffineTransform(translationX: -shift, y: 0)
                to.transform = .identity
            }
        }
        animator.addCompletion { [self] _ in
            // The tab that went (or, let go short of the middle, the one that
            // was coming), as it was, for the next time it shows. Only that
            // one: a tap on the tab bar before the end has another slide
            // under way with the other.
            let leaving = self.context?.transitionWasCancelled == true ? to : from
            leaving.transform = .identity
            leaving.alpha = 1
            complete(removing: to)
        }
        return animator
    }

    /// Hands the tab to the controller, or back to the tab it was on if the
    /// swipe was let go short of the middle.
    private func complete(removing incoming: UIView?) {
        guard let context else { return }
        self.context = nil
        let cancelled = context.transitionWasCancelled
        if cancelled { incoming?.removeFromSuperview() }
        context.completeTransition(!cancelled)
    }
}

/// A swipe's hold on the slide: it follows the finger, then runs on from
/// where the finger let go, at the finger's speed, to the new tab or back.
private final class SwipeInteraction: NSObject, UIViewControllerInteractiveTransitioning {
    let slide: Slide
    private var context: (any UIViewControllerContextTransitioning)?
    private var animator: UIViewPropertyAnimator?
    private var progress: CGFloat = 0
    /// Until a turn of the run loop after the controller starts the slide.
    private var isStarting = true
    /// Let go before then.
    private var pendingEnd: (finishing: Bool, speed: CGFloat, distance: CGFloat)?

    init(slide: Slide) {
        self.slide = slide
        super.init()
    }

    var wantsInteractiveStart: Bool { true }

    func startInteractiveTransition(_ context: any UIViewControllerContextTransitioning) {
        self.context = context
        let animator = slide.propertyAnimator(using: context)
        animator.fractionComplete = progress
        self.animator = animator
        context.updateInteractiveTransition(progress)
        // Let go in the same turn as the start, the slide went on to the new
        // tab whichever way it was let go: the end waits for the next.
        Task { @MainActor [self] in
            isStarting = false
            if let pendingEnd {
                end(finishing: pendingEnd.finishing, speed: pendingEnd.speed, distance: pendingEnd.distance)
            }
        }
    }

    func update(_ progress: CGFloat) {
        self.progress = progress
        guard pendingEnd == nil else { return }
        animator?.fractionComplete = progress
        context?.updateInteractiveTransition(progress)
    }

    /// `speed`: the finger's, in points a second towards the new tab.
    func end(finishing: Bool, speed: CGFloat, distance: CGFloat) {
        guard let animator, let context, !isStarting else {
            pendingEnd = (finishing, speed, distance)
            return
        }
        pendingEnd = nil
        if finishing {
            context.finishInteractiveTransition()
        } else {
            context.cancelInteractiveTransition()
        }
        animator.isReversed = !finishing
        // The spring starts at the finger's speed, as a share of the way left.
        let left = (finishing ? 1 - animator.fractionComplete : animator.fractionComplete) * distance
        let towardsEnd = finishing ? speed : -speed
        let initial = left > 1 ? max(towardsEnd, 0) / left : 0
        animator.continueAnimation(withTimingParameters: UISpringTimingParameters(dampingRatio: 1,
                                                                                  initialVelocity: CGVector(dx: initial, dy: 0)),
                                   durationFactor: 0)
    }
}
