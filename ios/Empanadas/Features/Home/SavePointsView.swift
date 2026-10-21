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
struct SavePointsView: View {
    @Environment(AppModel.self) private var model
    @State private var saves = SavePointsModel()
    /// The save point the player picked, being asked about.
    @State private var picked: SavePoint?

    var body: some View {
        Group {
            if let current = saves.current {
                list(current)
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
        // Afresh each time it opens: a game may have saved since.
        .task { await saves.refresh(app: model) }
        .onChange(of: model.isOnline) { _, online in
            if online, saves.error != nil { Task { await saves.refresh(app: model) } }
        }
        .sheet(item: $picked) { point in
            RestoreSheet(point: point, now: saves.current ?? SaveStats(), saves: saves)
        }
    }

    private func list(_ current: SaveStats) -> some View {
        List {
            Section {
                Text("Every so often we back up your progress, in case something happens. Pick a save point to put your games back the way they were then.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let error = saves.error, !saves.isLoading {
                Section {
                    Label(model.isOnline ? message(error) : "You're offline. Save points load once you're back online.",
                          systemImage: model.isOnline ? "exclamationmark.triangle" : "wifi.slash")
                        .font(.subheadline)
                    if model.isOnline {
                        Button("Try Again") { Task { await saves.refresh(app: model) } }
                    }
                }
            }

            Section {
                SaveStatsGrid(stats: current)
                    .padding(.vertical, 4)
            } header: {
                Text("Your Current Save")
            }

            Section {
                if saves.points.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("No save points yet", systemImage: "hourglass")
                            .font(.subheadline.weight(.semibold))
                        Text("They're recorded as you play the Spin Game, about once a day. Check back after your next session.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                } else {
                    ForEach(saves.points) { point in
                        Button { picked = point } label: {
                            SavePointRow(point: point, now: current)
                        }
                        .disabled(!point.restorable)
                        .accessibilityHint(point.restorable ? "Shows what restoring it changes" : "")
                    }
                    if saves.hasMore, saves.error == nil {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            // Again after each page, while the end is still
                            // in view.
                            .task(id: saves.loads) { await saves.loadMore(app: model) }
                    }
                }
            } header: {
                Text("Save Points")
            } footer: {
                if saves.hasSpinOnly {
                    Text("Spin Only save points are older. Restoring one puts back the Spin Game and leaves Flappy, Tower and your peppers as they are.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .readableListWidth()
        .refreshable { await saves.refresh(app: model) }
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

// MARK: - Rows

/// When a save point was saved, in the device's time and words, or as the
/// site wrote it if its date can't be read.
private struct SavedWhen {
    let point: SavePoint

    var date: String {
        point.savedAt?.formatted(date: .abbreviated, time: .shortened) ?? point.label
    }

    var ago: String {
        point.savedAt?.formatted(.relative(presentation: .named)) ?? point.ago
    }

    /// "Oct 17, 2026 at 9:18 PM (3 days ago)".
    var sentence: String {
        ago.isEmpty ? date : "\(date) (\(ago))"
    }
}

private struct SavePointRow: View {
    let point: SavePoint
    let now: SaveStats

    var body: some View {
        let when = SavedWhen(point: point)

        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(when.date)
                        .font(.subheadline.weight(.semibold))
                    if !when.ago.isEmpty {
                        Text(when.ago)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if point.restorable {
                    Text("Restore")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }

            if !point.full || !point.restorable {
                HStack(spacing: 6) {
                    if !point.full {
                        Tag(text: "Spin Only", tint: .secondary)
                    }
                    if !point.restorable {
                        Tag(text: "Before an anti-cheat reset", tint: .red)
                    }
                }
            }

            SaveStatsGrid(stats: point.stats, now: now, point: point)
        }
        .padding(.vertical, 4)
        .foregroundStyle(.primary)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct Tag: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
    }
}

/// A save's six numbers, three across. Against the account's now when `now`
/// is given: higher or lower, and dimmed where restoring `point` would leave
/// the number as it is.
private struct SaveStatsGrid: View {
    let stats: SaveStats
    var now: SaveStats?
    var point: SavePoint?

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
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
        var trend = SaveTrend.same
        if let now, !kept {
            trend = SaveTrend(stats[stat], now: now[stat])
        }

        return VStack(alignment: .leading, spacing: 1) {
            Text(stat.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            HStack(spacing: 3) {
                Text(SaveStatsGrid.value(stats[stat]))
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(kept ? HierarchicalShapeStyle.secondary : .primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                TrendArrow(trend: trend)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityHint(kept ? "Not in this save point, so restoring it leaves this as it is" : "")
    }

    static func value(_ number: Int?) -> String {
        number?.formatted() ?? "—"
    }
}

private struct TrendArrow: View {
    let trend: SaveTrend

    var body: some View {
        switch trend {
        case .higher:
            Image(systemName: "arrowtriangle.up.fill")
                .font(.system(size: 8))
                .foregroundStyle(Palette.flappy)
                .accessibilityLabel("higher than now")
        case .lower:
            Image(systemName: "arrowtriangle.down.fill")
                .font(.system(size: 8))
                .foregroundStyle(Palette.peppers)
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
                    HStack {
                        Text("Overwrite My Saves")
                        if restoring {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(saves.restoring != nil || !model.isOnline)
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
