import SwiftUI

/// What the Home tab pushes for Manage Game Data.
enum GameDataRoute: Hashable {
    case savePoints
}

extension View {
    /// Lets Manage Game Data be pushed in this navigation stack.
    func gameDataDestinations() -> some View {
        navigationDestination(for: GameDataRoute.self) { _ in
            SavePointsView()
        }
    }
}

/// Manage Game Data, native: the site dashboard's dialog of the same name
/// (dashboard-v2_2.js), opened from the Spin Progress card as it is there.
/// The save points the site keeps as the Spin Game saves, newest first, each
/// against the account as it is now, and putting the account back to one of
/// them after asking (RestoreSheet).
///
/// Drawn as cards on the grouped background, like Home: a brand header, the
/// current save as coloured tiles, and each save point with a solid Restore
/// button and +/− pills for what restoring it changes.
struct SavePointsView: View {
    @Environment(AppModel.self) private var model
    @State private var saves = SavePointsModel()
    /// The save point the player picked, being asked about.
    @State private var picked: SavePoint?

    var body: some View {
        Group {
            if let current = saves.current {
                content(current)
            } else if let error = saves.error, !saves.isLoading {
                loadFailed(error)
            } else {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Manage Game Data")
        .navigationBarTitleDisplayMode(.inline)
        .glassNavigationBar()
        // Afresh each time it opens: a game may have saved since.
        .task { await saves.refresh(app: model) }
        .onChange(of: model.isOnline) { _, online in
            if online, saves.error != nil { Task { await saves.refresh(app: model) } }
        }
        .sheet(item: $picked) { point in
            RestoreSheet(point: point, now: saves.current ?? SaveStats(), saves: saves)
        }
    }

    private func content(_ current: SaveStats) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                header

                if let error = saves.error, !saves.isLoading {
                    problem(error)
                }

                Card("Your Current Save", systemImage: "gamecontroller.fill", tint: Palette.spin) {
                    SaveStatsGrid(stats: current)
                }

                sectionTitle("Save Points", systemImage: "clock.arrow.circlepath")
                    .padding(.top, 4)

                if saves.points.isEmpty {
                    empty
                } else {
                    ForEach(saves.points) { point in
                        SavePointCard(point: point, now: current) { picked = point }
                    }
                    if saves.hasMore, saves.error == nil {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            // Again after each page, while the end is still
                            // in view.
                            .task(id: saves.loads) { await saves.loadMore(app: model) }
                    }
                }

                if saves.hasSpinOnly {
                    Label("Spin Only save points are older. Restoring one puts back the Spin Game and leaves Flappy, Tower and your peppers as they are.",
                          systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                }
            }
            .padding(.horizontal)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .readableWidth(ReadableWidth.narrow)
        }
        .refreshable { await saves.refresh(app: model) }
    }

    /// White on the brand gradient, as Home's hero is.
    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "externaldrive.fill.badge.timemachine")
                .font(.title2.weight(.semibold))
                .frame(width: 48, height: 48)
                .background(.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Your Progress, Backed Up")
                    .font(.headline)
                Text("Every so often we back up your progress, in case something happens. Pick a save point to put your games back the way they were then.")
                    .font(.subheadline)
                    .opacity(0.9)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(.white)
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Color("Brand"), Color(hex: 0x4A5BF0)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    private func sectionTitle(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.title3.bold())
            .foregroundStyle(.primary)
            .padding(.horizontal, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private var empty: some View {
        Card {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "hourglass")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Palette.idle.gradient, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("No save points yet")
                        .font(.subheadline.weight(.semibold))
                    Text("They're recorded as you play the Spin Game, about once a day. Check back after your next session.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func problem(_ error: AccountError) -> some View {
        Card {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: model.isOnline ? "exclamationmark.triangle.fill" : "wifi.slash")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background((model.isOnline ? Palette.idle : Color.gray).gradient,
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.isOnline ? message(error) : "You're offline. Save points load once you're back online.")
                        .font(.subheadline)
                    if model.isOnline {
                        Button("Try Again") { Task { await saves.refresh(app: model) } }
                            .font(.subheadline.weight(.semibold))
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                }
            }
        }
    }

    private func loadFailed(_ error: AccountError) -> some View {
        ContentUnavailableView {
            Label(model.isOnline ? "Couldn't Load Your Save Points" : "You're Offline",
                  systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
        } description: {
            Text(model.isOnline ? message(error) : "Save points load once you're back online.")
        } actions: {
            if model.isOnline {
                Button("Try Again") { Task { await saves.refresh(app: model) } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func message(_ error: AccountError) -> String {
        if case .unavailable(let detail) = error {
            return "Your save points couldn't be loaded (\(detail))."
        }
        return error.localizedDescription
    }
}

// MARK: - Look

/// Each number's symbol and colour, the games' own where it belongs to one.
private extension SaveStat {
    var systemImage: String {
        switch self {
        case .prestige: "crown.fill"
        case .ascensions: "sparkles"
        case .manualSpins: Game.spin.systemImage
        case .peppers: "flame.fill"
        case .flappyBest: Game.flappy.systemImage
        case .towerBest: Game.tower.systemImage
        }
    }

    var tint: Color {
        switch self {
        case .prestige: Palette.friends
        case .ascensions: Color(hex: 0x0E9AA7)
        case .manualSpins: Palette.spin
        case .peppers: Palette.peppers
        case .flappyBest: Palette.flappy
        case .towerBest: Palette.tower
        }
    }
}

/// Text colours that keep at least 4.5:1 on the card in light and dark mode:
/// the palette's own green and red are too pale for small text on white.
private enum DeltaColor {
    static let gain = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0x4A / 255, green: 0xDE / 255, blue: 0x9A / 255, alpha: 1)
        : UIColor(red: 0x0B / 255, green: 0x74 / 255, blue: 0x4C / 255, alpha: 1) })
    static let loss = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0xFF / 255, green: 0x85 / 255, blue: 0x7A / 255, alpha: 1)
        : UIColor(red: 0xB4 / 255, green: 0x23 / 255, blue: 0x18 / 255, alpha: 1) })
}

/// The Restore button's fill: the brand gradient, white on it.
private var restoreFill: LinearGradient {
    LinearGradient(colors: [Color(hex: 0x3756E9), Color(hex: 0x4A5BF0)],
                   startPoint: .topLeading, endPoint: .bottomTrailing)
}

// MARK: - Rows

/// When a save point was saved, in the device's time and words, or as the
/// site wrote it if its date can't be read.
private struct SavedWhen {
    let point: SavePoint

    var date: String {
        point.savedAt?.formatted(date: .abbreviated, time: .shortened) ?? point.label
    }

    /// Beside the calendar badge, which already says the day: "Sunday, 8:12 PM",
    /// with the year as well when it isn't this one.
    var title: String {
        guard let saved = point.savedAt else { return point.label }
        let thisYear = Calendar.current.isDate(saved, equalTo: .now, toGranularity: .year)
        return thisYear
            ? saved.formatted(.dateTime.weekday(.wide).hour().minute())
            : saved.formatted(date: .abbreviated, time: .shortened)
    }

    var ago: String {
        point.savedAt?.formatted(.relative(presentation: .named)) ?? point.ago
    }

    /// "Oct 17, 2026 at 9:18 PM (3 days ago)".
    var sentence: String {
        ago.isEmpty ? date : "\(date) (\(ago))"
    }
}

/// One save point: a calendar badge, when, a solid Restore button, and its
/// numbers against now.
private struct SavePointCard: View {
    let point: SavePoint
    let now: SaveStats
    let restore: () -> Void

    var body: some View {
        Button(action: restore) { card }
            .buttonStyle(PressableCardStyle())
            .disabled(!point.restorable)
            .accessibilityHint(point.restorable ? "Shows what restoring it changes" : "")
    }

    private var card: some View {
        let when = SavedWhen(point: point)

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                CalendarBadge(date: point.savedAt, faded: !point.restorable)
                VStack(alignment: .leading, spacing: 3) {
                    Text(when.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                    if !when.ago.isEmpty {
                        Text(when.ago.capitalizedFirst)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
                // The badge is hidden from VoiceOver, so the whole date here.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Saved \(when.sentence)")
                Spacer(minLength: 8)
                if point.restorable {
                    Label("Restore", systemImage: "arrow.counterclockwise")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(restoreFill, in: Capsule())
                } else {
                    Image(systemName: "lock.fill")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Can't be restored")
                }
            }

            if !point.full || !point.restorable {
                HStack(spacing: 6) {
                    if !point.full {
                        Tag(text: "Spin Only", systemImage: "arrow.triangle.2.circlepath", tint: Palette.spin)
                    }
                    if !point.restorable {
                        Tag(text: "Before an anti-cheat reset", systemImage: "shield.slash.fill", tint: DeltaColor.loss)
                    }
                }
            }

            Divider()

            SaveStatsGrid(stats: point.stats, now: now, point: point)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(.primary)
        .background(Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Dims and shrinks a card a little while it's held; a disabled one stays
/// as it is rather than going grey.
private struct PressableCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.18), value: configuration.isPressed)
    }
}

/// A tear-off calendar page: the month on a coloured strip, the day under it.
private struct CalendarBadge: View {
    let date: Date?
    var faded = false

    var body: some View {
        VStack(spacing: 0) {
            Text(date?.formatted(.dateTime.month(.abbreviated)).uppercased() ?? "—")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 2)
                .background(faded ? AnyShapeStyle(Color.gray) : AnyShapeStyle(restoreFill))
            Text(date?.formatted(.dateTime.day()) ?? "?")
                .font(.title3.weight(.bold).monospacedDigit())
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 46, height: 50)
        .background(Color(uiColor: .tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(Color.primary.opacity(0.08)))
        .accessibilityHidden(true)
    }
}

private struct Tag: View {
    let text: String
    var systemImage: String?
    let tint: Color

    var body: some View {
        Label {
            Text(text)
        } icon: {
            if let systemImage { Image(systemName: systemImage) }
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(tint.opacity(0.14), in: Capsule())
    }
}

/// A save's six numbers, three across, each with its colour and symbol.
/// Against the account's now when `now` is given: how much higher or lower,
/// and dimmed where restoring `point` would leave the number as it is.
/// The current save sits on tinted tiles; a save point's numbers don't, so
/// more of the list fits on screen.
private struct SaveStatsGrid: View {
    let stats: SaveStats
    var now: SaveStats?
    var point: SavePoint?

    private var tiled: Bool { point == nil }

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 10, verticalSpacing: tiled ? 10 : 14) {
            GridRow {
                cell(.prestige)
                cell(.ascensions)
                cell(.manualSpins)
            }
            GridRow {
                cell(.peppers)
                cell(.flappyBest)
                cell(.towerBest)
            }
        }
    }

    private func cell(_ stat: SaveStat) -> some View {
        let kept = point.map { !$0.changes(stat) } ?? false
        let delta: Int? = (now != nil && !kept) ? (stats[stat] ?? 0) - (now?[stat] ?? 0) : nil

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: stat.systemImage)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background((kept ? Color.gray : stat.tint).gradient,
                                in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                    .accessibilityHidden(true)
                Text(stat.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            Text(SaveStatsGrid.value(stats[stat]))
                .font(.headline.monospacedDigit())
                .foregroundStyle(kept ? HierarchicalShapeStyle.tertiary : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if kept {
                Text("Unchanged")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            } else if let delta, delta != 0 {
                DeltaPill(delta: delta)
            }
        }
        .padding(tiled ? 10 : 0)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(tiled ? stat.tint.opacity(0.08) : .clear,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint(kept ? "Not in this save point, so restoring it leaves this as it is" : "")
    }

    static func value(_ number: Int?) -> String {
        number?.formatted() ?? "—"
    }
}

/// How far a save point's number is from now: green above, red below.
private struct DeltaPill: View {
    let delta: Int

    var body: some View {
        let up = delta > 0
        HStack(spacing: 2) {
            Image(systemName: up ? "arrow.up" : "arrow.down")
                .font(.system(size: 9, weight: .heavy))
            Text(abs(delta), format: .number.notation(.compactName))
                .font(.caption2.weight(.bold).monospacedDigit())
        }
        .foregroundStyle(up ? DeltaColor.gain : DeltaColor.loss)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background((up ? DeltaColor.gain : DeltaColor.loss).opacity(0.14), in: Capsule())
        .accessibilityElement()
        .accessibilityLabel(up ? "\(delta.formatted()) higher than now" : "\(abs(delta).formatted()) lower than now")
    }
}

private extension String {
    /// "yesterday" → "Yesterday", leaving the rest alone.
    var capitalizedFirst: String {
        prefix(1).uppercased() + dropFirst()
    }
}

private struct TrendArrow: View {
    let trend: SaveTrend
    /// 8 points at the default text size, growing with the player's.
    @ScaledMetric(relativeTo: .caption2) private var size: CGFloat = 9

    var body: some View {
        switch trend {
        case .higher:
            Image(systemName: "arrowtriangle.up.fill")
                .font(.system(size: size))
                .foregroundStyle(DeltaColor.gain)
                .accessibilityLabel("higher than now")
        case .lower:
            Image(systemName: "arrowtriangle.down.fill")
                .font(.system(size: size))
                .foregroundStyle(DeltaColor.loss)
                .accessibilityLabel("lower than now")
        case .same:
            EmptyView()
        }
    }
}

// MARK: - Restoring

/// Asks before putting the account back to a save point, showing what each
/// number becomes (gdConfirm() on the web); then puts it back, and says so.
private struct RestoreSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let point: SavePoint
    let saves: SavePointsModel

    /// The account as it was when the sheet opened: what the numbers are
    /// compared with, even once the restore has changed it.
    @State private var now: SaveStats
    @State private var done = false
    @State private var failure: String?

    init(point: SavePoint, now: SaveStats, saves: SavePointsModel) {
        self.point = point
        self.saves = saves
        _now = State(initialValue: now)
    }

    private var restoring: Bool { saves.restoring == point.id }

    var body: some View {
        NavigationStack {
            Group {
                if done {
                    restored
                } else {
                    question
                }
            }
            .navigationTitle(done ? "Save Restored" : "Overwrite Save?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: done ? .confirmationAction : .cancellationAction) {
                    Button(done ? "Done" : "Cancel") { dismiss() }
                        .disabled(restoring)
                }
            }
            .interactiveDismissDisabled(restoring)
            .alert("Couldn't Restore That Save", isPresented: Binding(
                get: { failure != nil },
                set: { if !$0 { failure = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
        }
    }

    private var question: some View {
        Form {
            Section {
                Label {
                    Text("Your saves will be overwritten with the save point from \(SavedWhen(point: point).sentence).")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                }
            }

            Section {
                ForEach(SaveStat.allCases) { stat in
                    LabeledContent(stat.label) { change(stat) }
                }
            } header: {
                Text("Now → Save Point")
            }

            Section {
                Text(point.full
                     ? "Your Spin, Flappy and Tower saves and your pepper balance all go back to this point."
                     : "This save point is from before Flappy, Tower and peppers were kept with it, so only the Spin Game changes.")
                Text("Your current progress is kept as a new save point first, so you can undo this.")
            }
            .font(.subheadline)

            Section {
                Button(role: .destructive) {
                    restore()
                } label: {
                    HStack(spacing: 8) {
                        if restoring {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "arrow.counterclockwise")
                        }
                        Text("Overwrite My Saves")
                    }
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .disabled(saves.restoring != nil || !model.isOnline)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } footer: {
                if !model.isOnline {
                    Text("You're offline. Restoring a save needs a connection.")
                }
            }
        }
    }

    /// One number now, and what it becomes.
    @ViewBuilder
    private func change(_ stat: SaveStat) -> some View {
        if point.changes(stat) {
            HStack(spacing: 6) {
                Text(SaveStatsGrid.value(now[stat]))
                    .foregroundStyle(.secondary)
                Image(systemName: "arrow.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("becomes")
                Text(SaveStatsGrid.value(point.stats[stat]))
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
                TrendArrow(trend: SaveTrend(point.stats[stat], now: now[stat]))
            }
            .monospacedDigit()
            .accessibilityElement(children: .combine)
        } else {
            Text("\(SaveStatsGrid.value(now[stat])) · No change")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    private var restored: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 60))
                .foregroundStyle(Palette.flappy)
                .symbolEffect(.bounce, value: done)
                .accessibilityHidden(true)
            Text("Your games are back to how they were on \(SavedWhen(point: point).date).")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("They pick up from there the next time you play. What you had before is the newest save point, if you change your mind.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                dismiss()
            } label: {
                Text("Done").frame(minWidth: 120)
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 6)
        }
        .padding(24)
        .frame(maxWidth: 460)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func restore() {
        guard saves.restoring == nil else { return }
        Haptics.play("warning")
        Task {
            if let message = await saves.restore(point, app: model) {
                failure = message
            } else {
                Haptics.play("success")
                withAnimation(.smooth) { done = true }
            }
        }
    }
}
