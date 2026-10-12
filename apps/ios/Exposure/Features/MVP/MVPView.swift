import ExposureCore
import SwiftUI

struct MVPView: View {
    let brandName: String
    let configuration: Result<APIConfiguration, Error>
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: ScanModel
    @State private var showSignIn = false
    @State private var showAddAddress = false
    @State private var removingAddress: AddressSummary?
    @State private var confirmDeletion = false

    init(brandName: String, configuration: Result<APIConfiguration, Error>) {
        self.brandName = brandName
        self.configuration = configuration
        _model = State(initialValue: ScanModel(configuration: configuration))
    }

    var body: some View {
        TabView {
            NavigationStack {
                List {
                    if !model.isSignedIn {
                        Section {
                            Text("Check your email for known data breaches").font(.headline)
                            Text("Sign in to see your breach count. Upgrade to Pro for details and proactive monitoring.")
                            Button("Get started") { showSignIn = true }
                        }
                    }
                    Section("Your results") {
                        if let address = model.selectedAddress {
                            Text(address.email)
                            if let count = address.knownBreachCount {
                                LabeledContent("Known breaches", value: String(count))
                                if let timestamp = address.checkedAt {
                                    Text("Last successful scan: \(displayDate(timestamp))")
                                        .font(.footnote).foregroundStyle(.secondary)
                                }
                                if model.canViewFindings {
                                    NavigationLink("Remediation dashboard") { FindingsView(model: model) }
                                } else { NavigationLink("Unlock breach details") { SubscriptionView(model: model) } }
                            } else { Text("Your email is verified. Run your first scan to see its known breach count.") }
                            Button(model.isScanning ? "Scanning…" : "Scan email") { Task { await model.scan() } }
                                .disabled(model.requiresConnection || model.isPaused(address))
                            if model.isPaused(address) { Text("This address is paused above your current plan quota.") }
                            if model.isScanning { ProgressView("Checking for known breaches…") }
                        } else if model.isSignedIn {
                            Text("Your account could not be loaded.")
                            Button("Retry loading account") { Task { await model.reloadAccount() } }.disabled(model.requiresConnection)
                        } else {
                            ContentUnavailableView("No scan results", systemImage: "magnifyingglass",
                                description: Text("Sign in and verify your email before scanning. No scan has been performed."))
                        }
                        errorMessage
                    }
                    Section("Security guidance") {
                        Text("Use a unique password for each account and turn on multi-factor authentication where available.")
                        Text("Known breach records cannot tell you whether an account is currently compromised. A clean result cannot guarantee safety.")
                    }
                }
                .navigationTitle(brandName)
            }
            .tabItem { Label("Scan", systemImage: "magnifyingglass") }

            NavigationStack {
                List {
                    Section("Verified addresses") {
                        if let account = model.account {
                            ForEach(model.addresses, id: \.id) { address in
                                VStack(alignment: .leading, spacing: 8) {
                                    Button { model.selectAddress(address) } label: {
                                        Label(address.email, systemImage: model.selectedAddress?.id == address.id ? "checkmark.circle.fill" : "circle")
                                    }.disabled(model.isBusy)
                                    Text(address.isPrimary == true ? "Primary sign-in email" : "Verified additional email").font(.caption)
                                    if model.isPaused(address) { Text("Paused — above plan quota").font(.caption) }
                                    if address.isPrimary != true {
                                        Button("Remove address", role: .destructive) { removingAddress = address }.disabled(model.requiresConnection)
                                    }
                                }.buttonStyle(.borderless)
                            }
                            Text("\(model.addresses.count) of \(account.quota) addresses on your \(account.tier) plan.")
                            Button("Add an email address") { showAddAddress = true }
                                .disabled(model.requiresConnection || account.tier != "premium" || model.addresses.count >= account.quota)
                            Button("Refresh addresses") { Task { await model.reloadAccount() } }.disabled(model.requiresConnection)
                            errorMessage
                        } else if model.isSignedIn {
                            Text("Connect to load your verified addresses.")
                            Button("Try again") { Task { await model.refreshSavedContent() } }.disabled(model.isBusy)
                        } else {
                            Text("Sign in to verify your first address.")
                            Button("Verify an email address") { showSignIn = true }.disabled(model.requiresConnection || model.isSignedIn)
                        }
                    }
                    Section {
                        Text("Additional addresses need a paid plan and independent verification. Family members must consent before their addresses are added.")
                    }
                }
                .navigationTitle("Addresses")
            }
            .tabItem { Label("Addresses", systemImage: "envelope") }

            NavigationStack {
                List {
                    Section("Proactive monitoring") {
                        if let address = model.selectedAddress {
                            Text(address.email)
                            if let status = model.monitoring {
                                LabeledContent("Status", value: status.paused ? "Paused by plan" : status.enabled ? "Enabled" : "Disabled")
                                if let last = status.lastCheckedAt { Text("Last successful check: \(displayDate(last))") }
                                if let next = status.nextCheckAt, status.enabled && !status.paused {
                                    Text("Next check due: \(Date(timeIntervalSince1970: Double(next)).formatted(date: .abbreviated, time: .shortened))")
                                }
                                Toggle("Proactive monitoring", isOn: Binding(
                                    get: { status.enabled },
                                    set: { enabled in Task { await model.setMonitoring(enabled: enabled) } }
                                )).disabled(model.requiresConnection || (!status.enabled && (model.account?.tier != "premium" || model.isPaused(address))))
                            }
                            Button("Refresh monitoring status") { Task { await model.reloadMonitoring() } }.disabled(model.requiresConnection)
                        } else { Text(model.isSignedIn ? "Connect to load your monitoring status." : "Sign in and select a verified email first.") }
                        Text("New findings appear in your dashboard. Checks are periodic, not real-time.")
                        NavigationLink("View subscription options") { SubscriptionView(model: model) }
                        errorMessage
                    }
                    Section("Notifications") {
                        Text("Push notifications are not available yet. Check your dashboard for new findings.")
                    }
                }
                .navigationTitle("Monitoring")
                .task(id: model.selectedAddress?.id) { await model.reloadMonitoring() }
            }
            .tabItem { Label("Monitoring", systemImage: "bell") }

            NavigationStack {
                List {
                    Section("Account") {
                        LabeledContent("Status", value: model.isSignedIn ? (model.isOffline ? "Signed in · offline" : "Signed in") : "Signed out")
                        if let account = model.account { Text(account.address.email) }
                        if model.isSignedIn {
                            NavigationLink("Signed-in devices and sessions") { SessionsView(model: model) }
                            Button("Sign out") { Task { await model.logout() } }.disabled(model.isBusy)
                            Button("Delete account", role: .destructive) { confirmDeletion = true }.disabled(model.requiresConnection)
                        } else { Button("Sign in") { showSignIn = true }.disabled(model.requiresConnection) }
                        NavigationLink("Subscription") { SubscriptionView(model: model) }
                        errorMessage
                    }
                    Section("Privacy and help") {
                        Link("Email support", destination: URL(string: "mailto:security@cybrguard.app?subject=CybrGuard%20support")!)
                        LegalLinks()
                        NavigationLink("Help") {
                            InformationView(title: "Help", paragraphs: [
                                "Enter your email, agree to breach checking and request a verification code. Enter the six-digit (XXX-XXX) code from your inbox within 10 minutes. Each code can be used once; after five incorrect attempts request a new code.",
                                "Once verified, tap Scan email. Re-scans are limited to once per minute. Provider errors preserve the last successful result.",
                                "If a check fails, try again when you have an internet connection. Your last successful results stay available."
                            ])
                        }
                    }
                    #if DEBUG
                    Section("Development") {
                        NavigationLink("Connection status") {
                            DevelopmentStatusView(brandName: brandName, configuration: configuration)
                        }
                    }
                    #endif
                }
                .navigationTitle("Settings")
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.isOffline {
                VStack(alignment: .leading, spacing: 4) {
                    Label(model.savedAt == nil ? "You’re offline" : "Offline — showing saved information", systemImage: "wifi.slash").font(.subheadline)
                    if let savedAt = model.savedAt {
                        Text("Last updated \(savedAt.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                    } else { Text("Connect to load your account and results.").font(.caption) }
                    Button("Try again") { Task { await model.refreshSavedContent() } }.disabled(model.isBusy)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal).padding(.vertical, 8)
                .background(.regularMaterial)
            }
        }
        .task {
            model.startConnectivityMonitoring()
            await model.restore()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { break }
                model.expireOfflineAccess()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshSavedContent() } }
        }
        .sheet(isPresented: $showSignIn, onDismiss: { model.cancelVerification() }) { SignInView(model: model) }
        .sheet(isPresented: $showAddAddress, onDismiss: { model.cancelAddressVerification() }) { SignInView(model: model, additional: true) }
        .confirmationDialog("Remove this address and its stored findings?", isPresented: Binding(get: { removingAddress != nil }, set: { if !$0 { removingAddress = nil } }), titleVisibility: .visible) {
            if let address = removingAddress {
                Button("Remove address", role: .destructive) { Task { await model.removeAddress(address); removingAddress = nil } }
            }
        }
        .confirmationDialog("Delete your CybrGuard account and stored data?", isPresented: $confirmDeletion, titleVisibility: .visible) {
            Button("Delete account permanently", role: .destructive) { Task { await model.deleteAccount() } }
        } message: { Text("Your email, findings, remediation marks, scan count and sessions will be removed. Historical breach records held by other services will remain. Deleting your account does not cancel your subscription.") }
    }

    @ViewBuilder private var errorMessage: some View {
        if let message = model.message { Text(message).foregroundStyle(.red).accessibilityLabel("Error: \(message)") }
    }
    private func displayDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct SessionsView: View {
    let model: ScanModel
    @State private var confirmOthers = false
    var body: some View {
        List {
            Section("Active sign-ins") {
                ForEach(model.sessions) { session in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(session.current ? "This session" : "Another signed-in session")
                        Text("Expires \(Date(timeIntervalSince1970: Double(session.expiresAt)).formatted(date: .abbreviated, time: .shortened))").font(.caption)
                        Text("Session \(session.id.prefix(8))").font(.caption).foregroundStyle(.secondary)
                        if !session.current {
                            Button("Sign out this session", role: .destructive) { Task { await model.revokeSession(session) } }.disabled(model.requiresConnection)
                        }
                    }.buttonStyle(.borderless)
                }
                Button("Refresh sessions") { Task { await model.reloadSessions() } }.disabled(model.requiresConnection)
                Button("Sign out all other sessions", role: .destructive) { confirmOthers = true }.disabled(model.requiresConnection || model.sessions.count < 2)
                if let message = model.message { Text(message).foregroundStyle(.red) }
            }
            Text("Each sign-in creates a separate session. Device names and locations are not collected.")
        }
        .navigationTitle("Signed-in sessions")
        .task { await model.reloadSessions() }
        .confirmationDialog("Sign out all other sessions?", isPresented: $confirmOthers, titleVisibility: .visible) {
            Button("Sign out other sessions", role: .destructive) { Task { await model.revokeOtherSessions() } }
        }
    }
}

private struct SignInView: View {
    @Environment(\.dismiss) private var dismiss
    let model: ScanModel
    var additional = false
    @State private var email = ""
    @State private var consent = false
    @State private var showVerification = false

    private var validEmail: Bool {
        let value = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !value.contains(where: { $0.isWhitespace })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Your email address") {
                    TextField("Email address", text: $email)
                        .textContentType(.emailAddress).keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Email address")
                    Text("Use an address you own or have permission to verify. Results require the one-time code delivered to this mailbox.")
                }
                Section {
                    Toggle(additional ? "I have the mailbox owner’s permission to verify and monitor this email." : "I agree to checking my verified email for known breaches.", isOn: $consent)
                    Text("We’ll send a code to confirm access before checking for breaches. Read how we use your information below.")
                        .font(.footnote).foregroundStyle(.secondary)
                    LegalLinks()
                }
                Section {
                    Button(model.isBusy ? "Sending…" : "Send verification code") {
                        Task { if await (additional ? model.startAddress(email: email) : model.start(email: email)) { showVerification = true } }
                    }.disabled(!validEmail || !consent || model.requiresConnection)
                    if model.isBusy { ProgressView() }
                    if let message = model.message { Text(message).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Verify your email")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(model.isBusy) } }
            .navigationDestination(isPresented: $showVerification) { VerificationView(model: model, email: email, additional: additional) }
        }
        .interactiveDismissDisabled(model.isBusy)
        .onChange(of: model.isSignedIn) { _, signedIn in if signedIn && !additional { dismiss() } }
        .onChange(of: model.addresses.count) { old, new in if additional && new > old { dismiss() } }
    }
}

private struct VerificationView: View {
    let model: ScanModel
    let email: String
    var additional = false
    @State private var code = ""
    @State private var resendAfter = Date().addingTimeInterval(60)

    var body: some View {
        Form {
            Section("Verification code") {
                Text(email)
                Text("Check your inbox and junk folder. The six-digit (XXX-XXX) code expires in 10 minutes.")
                TextField("123-456", text: $code)
                    .textContentType(.oneTimeCode).keyboardType(.numberPad)
                    .accessibilityLabel("Verification code")
                    .onChange(of: code) { _, value in code = VerificationCode.formatted(value) }
                Button(model.isBusy ? "Verifying…" : "Verify email") {
                    Task { _ = await (additional ? model.verifyAddress(code: code) : model.verify(code: code)) }
                }.disabled(VerificationCode.digits(code).count != 6 || model.requiresConnection)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Button("Resend code") {
                        Task {
                            if await (additional ? model.startAddress(email: email) : model.start(email: email)) {
                                resendAfter = Date().addingTimeInterval(60)
                                code = ""
                            }
                        }
                    }.disabled(context.date < resendAfter || model.requiresConnection)
                }
                if model.isBusy { ProgressView() }
                if let message = model.message { Text(message).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Enter code")
    }
}

enum LegalContent {
    static let privacy = [
        "Draft privacy policy — requires review before public release.",
        "CybrGuard uses your verified email addresses to check for known data breaches and provide proactive monitoring. We also store verification and consent records, minimal breach details, your action progress and subscription status to operate your account.",
        "We use subprocessors to host and secure the service, deliver verification messages, check verified emails against breach records and manage subscriptions. They receive the information needed for those tasks, which may be processed outside Australia. We do not collect your passwords or display stolen credentials.",
        "Stored email addresses and breach details are encrypted, including saved results on your device for offline viewing. Saved device data is removed when you sign out or delete your account. Sign-in credentials are kept in your device’s secure storage. Verification codes expire after 10 minutes and can only be used once. We limit access to account information and do not include sensitive breach details in notification messages.",
        "You can remove additional addresses, turn off monitoring or delete your account in Settings. Account deletion removes your stored account data, findings, action progress and sign-in sessions. It does not remove historical records held by other services or cancel an Apple subscription.",
        "Contact security@cybrguard.app for privacy questions or account assistance. Retention periods and international processing arrangements must be finalised before public release."
    ]
    static let terms = [
        "Draft terms and conditions — require review before public release.",
        "Only verify and monitor addresses you own or have the owner’s permission to use. Every address requires independent verification. You agree that CybrGuard and its subprocessors may process verified addresses to provide breach checking and monitoring as described in the privacy policy.",
        "Free access includes a verified email’s known breach count. Pro includes breach details, action tracking and proactive monitoring within your plan’s address limit. Monitoring turns on automatically after a subscription is confirmed, including for newly verified eligible addresses. You can turn it off at any time. Monitoring checks are periodic, currently targeted about once a day, and are not real-time alerts.",
        "Subscriptions renew automatically unless cancelled. The purchase screen shows the price, billing period and any eligible trial before confirmation. Manage or cancel Apple subscriptions through your Apple account. Account deletion does not cancel your subscription. On expiry or downgrade, paid features and addresses above your plan limit are paused.",
        "Breach records describe known historical exposures. Coverage may be incomplete; no result guarantees that an account is safe or currently compromised. Marking a finding actioned records your own progress and does not erase the breach record.",
        "CybrGuard relies on subprocessors for service delivery. Checks may be delayed or unavailable, and previous successful results remain available when a check fails. Push notifications are not available in this testing build.",
        "Contact security@cybrguard.app for support. These draft terms do not exclude rights under Australian Consumer Law."
    ]
}

struct LegalLinks: View {
    var body: some View {
        NavigationLink("Privacy policy") { InformationView(title: "Privacy policy", paragraphs: LegalContent.privacy) }
        NavigationLink("Terms and conditions") { InformationView(title: "Terms and conditions", paragraphs: LegalContent.terms) }
    }
}

struct InformationView: View {
    let title: String
    let paragraphs: [String]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ForEach(paragraphs, id: \.self) { Text($0).frame(maxWidth: .infinity, alignment: .leading) }
            }.padding()
        }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}

private struct FindingsView: View {
    @Bindable var model: ScanModel
    @State private var filter: FindingFilter = .all
    private var dashboard: FindingsDashboard { FindingsDashboard(findings: model.findings) }

    private func remediationDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)?.formatted(date: .abbreviated, time: .omitted) ?? value
    }

    var body: some View {
        List {
            Section {
                Text("Highlighted findings report plaintext or easy-to-crack password storage.")
                Text("Remediated means you report taking action. CybrGuard cannot verify external password changes or remove historical breach records.").font(.footnote).foregroundStyle(.secondary)
            }
            if !model.canViewFindings {
                Text(model.isOffline ? "Connect to confirm Pro access and load your breach details." : "Upgrade to Pro to view breach details and track your actions.")
            } else if model.isBusy && model.findings.isEmpty {
                ProgressView("Loading findings…")
            } else if model.findings.isEmpty {
                Text(model.findingsCheckedAt == nil ? (model.isOffline ? "No saved details for this address. Connect to load them." : "Run a new scan to load detailed findings.") : "No known breaches were returned by the last detailed scan.")
            }
            if model.canViewFindings {
                Section("Progress") {
                    LabeledContent("Needs attention", value: String(dashboard.outstanding))
                    LabeledContent("Remediated", value: String(dashboard.remediated))
                    LabeledContent("Password storage risks", value: String(dashboard.passwordRisks))
                    LabeledContent("Checklist progress", value: "\(dashboard.completedActions) of \(dashboard.totalActions) actions")
                    if let date = model.findingsCheckedAt { Text("Last detailed scan: \(remediationDate(date))").font(.footnote) }
                    Picker("Show findings", selection: $filter) {
                        ForEach(FindingFilter.allCases) { option in Text(option.rawValue).tag(option) }
                    }
                }
                if !model.findings.isEmpty && dashboard.filtered(filter).isEmpty { Text("No findings match this filter.") }
                ForEach(dashboard.filtered(filter)) { finding in
                    Section {
                        Text(finding.breachId).font(.headline)
                        if finding.isNew == true { Label("Newly observed since your baseline", systemImage: "sparkle").font(.caption) }
                        if finding.passwordRiskHighlighted {
                            Label("Password storage risk", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange).font(.headline)
                        }
                        LabeledContent("Password storage", value: finding.passwordRisk ?? "Unknown")
                        if let date = finding.breachedAt { LabeledContent("Breach date", value: String(date.prefix(10))) }
                        if let domain = finding.domain { LabeledContent("Source domain", value: domain) }
                        if !finding.exposedData.isEmpty { Text("Exposed data: \(finding.exposedData.joined(separator: ", "))") }
                        if let description = finding.description { Text(description).font(.footnote) }
                        ForEach(finding.remediationSteps ?? []) { step in
                            VStack(alignment: .leading, spacing: 6) {
                                Button {
                                    Task { await model.setAction(finding, step: step, completed: step.completedAt == nil) }
                                } label: {
                                    Label(step.title, systemImage: step.completedAt == nil ? "circle" : "checkmark.circle.fill")
                                }
                                .accessibilityLabel("\(step.completedAt == nil ? "Complete" : "Undo"): \(step.title)")
                                .disabled(model.requiresConnection)
                                Text(step.detail).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        if let date = finding.remediatedAt {
                            Label("Remediated (self-reported) · \(remediationDate(date))", systemImage: "checkmark.circle")
                        }
                        Button(finding.remediatedAt == nil ? "Mark as remediated" : "Undo remediation mark") {
                            Task { await model.setRemediated(finding, remediated: finding.remediatedAt == nil) }
                        }.disabled(model.requiresConnection)
                    }
                }
            }
            if let message = model.message { Text(message).foregroundStyle(.red) }
        }
        .navigationTitle("Remediation")
        .task { await model.reloadFindings() }
        .refreshable { await model.reloadFindings() }
    }
}
