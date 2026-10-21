import SwiftUI

/// Where the launch animation is. RootView keeps it: the window stays dark
/// (white status bar on the navy) while it plays, and takes the app's own
/// style back as it starts to leave.
enum LaunchPhase {
    case playing
    case leaving
    case done
}

/// What the app shows as it starts, after the system's launch screen (plain
/// navy: UILaunchScreen in Info.plist): the desktop app's splash
/// (download.html and Content/CSS/splash.css), natively. The empanadas fly in
/// and land with a bounce, a warm glow comes up behind them, "Empanadas.io"
/// fades in and down underneath, a little steam rises, and the whole of it
/// fades away into the app, which has been loading underneath all along.
/// A tap skips it. With Reduce Motion, the logo and the name only fade in.
///
/// Once per launch: a second window (on an iPad or a Mac) opens without it.
struct LaunchAnimation: View {
    /// Set by the first window's RootView.
    @MainActor static var hasPlayed = false

    @Binding var phase: LaunchPhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start: Date?
    /// When it starts to leave, in seconds from the start: sooner than
    /// planned after a tap.
    @State private var leaveAt: TimeInterval?

    var body: some View {
        TimelineView(.animation) { context in
            LaunchScene(elapsed: start.map { context.date.timeIntervalSince($0) } ?? 0,
                        leaveAt: leaveAt ?? LaunchTiming.leave(reduceMotion: reduceMotion),
                        reduceMotion: reduceMotion)
        }
        .contentShape(Rectangle())
        .onTapGesture { skip() }
        .accessibilityHidden(true)
        .task(id: leaveAt) {
            let start = self.start ?? Date()
            if self.start == nil { self.start = start }
            let leave = leaveAt ?? LaunchTiming.leave(reduceMotion: reduceMotion)
            let exit = LaunchTiming.exit(reduceMotion: reduceMotion)
            try? await Task.sleep(for: .seconds(max(0, leave - Date().timeIntervalSince(start))))
            guard !Task.isCancelled else { return }
            phase = .leaving
            try? await Task.sleep(for: .seconds(exit))
            guard !Task.isCancelled else { return }
            phase = .done
        }
    }

    private func skip() {
        guard let start, phase == .playing else { return }
        leaveAt = Date().timeIntervalSince(start)
    }
}

/// The animation's clock, in seconds from the start. The logo's flight is
/// LaunchScene.flight.
enum LaunchTiming {
    /// The name, fading in and down under the logo as it lands.
    static let name: TimeInterval = 0.6
    static let nameDuration: TimeInterval = 0.6

    /// When it all starts to fade away into the app, and how long that takes:
    /// a moment after everything has landed.
    static func leave(reduceMotion: Bool) -> TimeInterval {
        reduceMotion ? 1.1 : 1.9
    }

    static func exit(reduceMotion: Bool) -> TimeInterval {
        reduceMotion ? 0.25 : 0.35
    }
}

/// One frame of the launch animation, `elapsed` seconds in: drawn from the
/// time alone, so the animation can be stepped through (the screenshot
/// tests draw it part way).
struct LaunchScene: View {
    let elapsed: TimeInterval
    var leaveAt: TimeInterval = LaunchTiming.leave(reduceMotion: false)
    var reduceMotion = false

    /// The logo, as wide as the welcome screen's. LaunchLogo is 607 by 407.
    private static let logoWidth: CGFloat = 220
    private static let logoHeight: CGFloat = logoWidth * 407 / 607

    /// The desktop splash's motion curve, cubic-bezier(.2, .8, .2, 1).
    private static let settle = UnitCurve.bezier(startControlPoint: UnitPoint(x: 0.2, y: 0.8),
                                                 endControlPoint: UnitPoint(x: 0.2, y: 1))

    /// Where the logo is on its way in. Offsets are fractions of the screen,
    /// so it comes from below the bottom edge on any of them.
    struct Flight {
        var x = -0.45
        var y = 0.62
        var scale = 0.35
        var angle = -40.0
        var opacity = 0.0
    }

    /// Up from the bottom left in an arc, turning upright as it comes, a
    /// little past where it lands, and back with a bounce.
    @MainActor static let flight = KeyframeTimeline(initialValue: Flight()) {
        KeyframeTrack(\.opacity) {
            LinearKeyframe(0, duration: 0.1)
            LinearKeyframe(1, duration: 0.2)
        }
        KeyframeTrack(\.x) {
            LinearKeyframe(-0.45, duration: 0.1)
            LinearKeyframe(0, duration: 0.6, timingCurve: .easeOut)
        }
        KeyframeTrack(\.y) {
            LinearKeyframe(0.62, duration: 0.1)
            SpringKeyframe(-0.018, duration: 0.55, spring: .smooth)
            SpringKeyframe(0, duration: 0.5, spring: .bouncy)
        }
        KeyframeTrack(\.scale) {
            LinearKeyframe(0.35, duration: 0.1)
            SpringKeyframe(1.08, duration: 0.55, spring: .smooth)
            SpringKeyframe(1, duration: 0.5, spring: .bouncy)
        }
        KeyframeTrack(\.angle) {
            LinearKeyframe(-40, duration: 0.1)
            SpringKeyframe(6, duration: 0.55, spring: .smooth)
            SpringKeyframe(0, duration: 0.5, spring: .bouncy)
        }
    }

    /// The steam's wisps: where each rises from across the steam's box, how
    /// tall it is, and when it first rises (splash.css's .steam i).
    private static let wisps: [(x: CGFloat, height: CGFloat, delay: TimeInterval)] = [
        (0.22, 0.7, 0.95), (0.46, 0.85, 1.25), (0.70, 0.7, 1.5),
    ]
    private static let wispCycle: TimeInterval = 1.8

    /// 0 until `start`, 1 from `start + duration`, and in between along
    /// `curve`.
    private func progress(_ start: TimeInterval, _ duration: TimeInterval, _ curve: UnitCurve = .linear) -> Double {
        let linear = min(max((elapsed - start) / duration, 0), 1)
        return curve.value(at: linear)
    }

    var body: some View {
        let leaving = progress(leaveAt, LaunchTiming.exit(reduceMotion: reduceMotion), .easeIn)

        GeometryReader { proxy in
            ZStack {
                Color("Brand")
                // The desktop splash's lit middle, coming up under the logo.
                RadialGradient(colors: [Color(hex: 0x2C2CB4), Color("Brand")], center: UnitPoint(x: 0.5, y: 0.42),
                               startRadius: 0, endRadius: max(proxy.size.width, proxy.size.height) * 0.55)
                    .opacity(progress(0, 0.6))

                VStack(spacing: 22) {
                    mark(in: proxy.size)
                    title
                }
                .scaleEffect(1 + 0.04 * leaving)
            }
        }
        .ignoresSafeArea()
        .opacity(1 - leaving)
    }

    // MARK: - The logo

    private func mark(in screen: CGSize) -> some View {
        let flight = reduceMotion
            ? Flight(x: 0, y: 0, scale: 1, angle: 0, opacity: progress(0.05, 0.35, .easeOut))
            : Self.flight.value(time: elapsed)

        return ZStack {
            glow
            // One piece, so the steam turns and lands with the logo.
            ZStack {
                if !reduceMotion {
                    steam
                        .offset(y: -0.31 * Self.logoHeight)
                }
                Image("LaunchLogo")
                    .resizable()
                    .scaledToFit()
            }
            .scaleEffect(flight.scale)
            .rotationEffect(.degrees(flight.angle))
            .offset(x: flight.x * screen.width, y: flight.y * screen.height)
            .opacity(flight.opacity)
        }
        .frame(width: Self.logoWidth, height: Self.logoHeight)
    }

    /// A warm glow behind the empanadas, breathing while it waits.
    private var glow: some View {
        let shown = progress(0.2, 0.9, .easeOut)
        // Smallest and faintest at the start of each 3.2 seconds, fullest
        // half way.
        let cycle = max(0, elapsed - 0.9) / 3.2
        let breath: Double = reduceMotion ? 1 : 0.5 - 0.5 * cos(2 * Double.pi * cycle)
        let gold = Color(hex: 0xFFC83D)

        return Ellipse()
            .fill(RadialGradient(stops: [
                .init(color: gold.opacity(0.32), location: 0),
                .init(color: gold.opacity(0.1), location: 0.38),
                .init(color: gold.opacity(0), location: 0.66),
            ], center: .center, startRadius: 0, endRadius: Self.logoWidth))
            .frame(width: Self.logoWidth * 1.9, height: Self.logoHeight * 1.9)
            .scaleEffect(0.94 + 0.1 * breath)
            .opacity(shown * (0.75 + 0.25 * breath))
    }

    /// Steam off a fresh batch, once the logo has landed: wisps rising and
    /// fading, one after another.
    private var steam: some View {
        let box = CGSize(width: Self.logoWidth * 0.6, height: Self.logoHeight * 0.5)

        return ZStack(alignment: .bottomLeading) {
            ForEach(Self.wisps.indices, id: \.self) { index in
                wisp(index, in: box)
            }
        }
        .frame(width: box.width, height: box.height, alignment: .bottomLeading)
    }

    private func wisp(_ index: Int, in box: CGSize) -> some View {
        let wisp = Self.wisps[index]
        let since = elapsed - wisp.delay
        // How far up this rise is, 0 to 1, easing in.
        var rise = 0.0
        if since >= 0 {
            rise = UnitCurve.easeIn.value(at: since.truncatingRemainder(dividingBy: Self.wispCycle) / Self.wispCycle)
        }
        // Up to 0.9 by 30% of the way, then gone by the top.
        var opacity = 0.0
        if since >= 0 {
            opacity = rise < 0.3 ? rise / 0.3 * 0.9 : 0.9 * (1 - (rise - 0.3) / 0.7)
        }
        let height = box.height * wisp.height

        return Capsule()
            .fill(LinearGradient(colors: [.white.opacity(0.7), .white.opacity(0)],
                                 startPoint: .bottom, endPoint: .top))
            .frame(width: box.width * 0.09, height: height)
            .scaleEffect(x: 1, y: CGFloat(0.6 + 0.5 * rise), anchor: .bottom)
            .offset(x: box.width * wisp.x + CGFloat(6 * rise), y: height * CGFloat(0.3 - rise))
            .blur(radius: 2)
            .opacity(opacity)
    }

    // MARK: - The name

    /// "Empanadas.io", fading in and down into place under the logo.
    private var title: some View {
        let shown = reduceMotion
            ? progress(0.15, 0.35, .easeOut)
            : progress(LaunchTiming.name, LaunchTiming.nameDuration, Self.settle)

        return Text("Empanadas.io")
            .font(.system(.largeTitle, design: .rounded).weight(.heavy))
            .foregroundStyle(.white)
            .offset(y: reduceMotion ? 0 : -16 * (1 - shown))
            .opacity(shown)
    }
}
