import SwiftUI

extension ServerStatus.Level {
    /// The site's own wording.
    var title: String {
        switch self {
        case .checking: "Checking…"
        case .operational: "Server Online"
        case .minor: "Possible Outage"
        case .major: "Partial Outage"
        case .critical: "Website Outage"
        case .unknown: "Unknown Status"
        }
    }

    var color: Color {
        switch self {
        case .operational: .green
        case .minor: .yellow
        case .major: .orange
        case .critical: .red
        case .checking, .unknown: .gray
        }
    }

    /// An answer from Statuspage, kept up to date: the light pulses for it.
    var isLive: Bool {
        switch self {
        case .operational, .minor, .major, .critical: true
        case .checking, .unknown: false
        }
    }

    /// What the warning says about a disruption (ServerStatusAlert).
    var warning: String {
        switch self {
        case .minor:
            "Empanadas.io may be having some trouble right now. You might run into interruptions or issues until it's sorted out."
        case .major:
            "Part of Empanadas.io isn't working right now. You may run into interruptions or issues until it's fixed."
        case .critical:
            "Empanadas.io is down right now. Expect interruptions or issues until it's back up."
        case .checking, .operational, .unknown:
            ""
        }
    }
}

/// The status light: a dot in the status's colour, and while the answer is
/// a live one, a ring that keeps pulsing out of it, to show it is kept up to
/// date. Still under Reduce Motion.
struct StatusDot: View {
    let color: Color
    var pulses = true
    var size: CGFloat = 10
    /// How far the ring gets, in multiples of the dot.
    var reach: CGFloat = 2.6

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .background {
                if pulses && !reduceMotion {
                    PulseRing(color: color, size: size, reach: reach)
                }
            }
            .animation(.easeOut(duration: 0.2), value: color)
            .accessibilityHidden(true)
    }
}

/// One ring every two seconds: out from the dot and fading as it goes, then
/// a pause. Drawn from the clock rather than a repeating animation, so a
/// list row being laid out or brought back on screen never sets it off
/// somewhere it should not be.
private struct PulseRing: View {
    let color: Color
    let size: CGFloat
    let reach: CGFloat

    var body: some View {
        TimelineView(.animation) { timeline in
            // Two seconds a ring: a second and a half on its way out, then
            // the pause.
            let elapsed = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2)
            let progress = min(elapsed / 1.5, 1)
            // Quick out of the dot, slowing as it fades.
            let eased = CGFloat(1 - pow(1 - progress, 3))
            let diameter = size * (1 + (reach - 1) * eased)
            Circle()
                .fill(color.opacity(0.18))
                .overlay { Circle().strokeBorder(color, lineWidth: 1.25) }
                .frame(width: diameter, height: diameter)
                .opacity(0.85 * (1 - progress))
        }
        .allowsHitTesting(false)
    }
}

/// The warning the app puts up when Statuspage reports a disruption: what
/// is wrong, and the way to the full status page. A card over the app rather
/// than a sheet or an alert, so it never fights one for the screen: it waits
/// until nothing else is up (RootView), and once dismissed it stays away
/// until things get worse, or are fixed and go wrong again
/// (ServerStatus.dismissAlert).
struct ServerStatusAlert: View {
    /// Nil while it is not showing.
    let level: ServerStatus.Level?
    let viewStatusPage: () -> Void
    let dismiss: () -> Void

    var body: some View {
        ZStack {
            if level != nil {
                Color.black.opacity(0.4)
                    .ignoresSafeArea()
                    .onTapGesture(perform: dismiss)
                    .accessibilityHidden(true)
                    .transition(.opacity)
            }
            if let level {
                // Too tall for the window (a phone on its side, a large text
                // size): the same card, scrolling.
                ViewThatFits(in: .vertical) {
                    card(level)
                    ScrollView { card(level) }
                        .scrollBounceBehavior(.basedOnSize)
                }
                .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
        }
        .animation(.spring(duration: 0.35, bounce: 0.25), value: level)
        .allowsHitTesting(level != nil)
        .onChange(of: level != nil) { _, showing in
            guard showing else { return }
            Haptics.play("warning")
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
    }

    private func card(_ level: ServerStatus.Level) -> some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(level.color.opacity(0.16))
                    .frame(width: 60, height: 60)
                StatusDot(color: level.color, size: 18, reach: 3.1)
            }
            .padding(.top, 4)

            VStack(spacing: 6) {
                Text(level.title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Color.primary)
                Text(level.warning)
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .multilineTextAlignment(.center)

            VStack(spacing: 10) {
                Button(action: viewStatusPage) {
                    Text("View Status Page")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button(action: dismiss) {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                        .foregroundStyle(Color.primary)
                }
                .buttonStyle(.bordered)
                .tint(.gray)
            }
            .controlSize(.large)
            .padding(.top, 4)
        }
        .padding(22)
        .frame(maxWidth: 340)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 28, style: .continuous))
        .overlay {
            // An edge, so the card stands off the dimmed app in dark mode.
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08))
        }
        .shadow(color: .black.opacity(0.22), radius: 24, y: 8)
        .padding(16)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, dismiss)
    }
}
