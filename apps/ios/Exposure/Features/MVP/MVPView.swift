import ExposureCore
import SwiftUI

struct MVPView: View {
    let brandName: String
    let configuration: Result<APIConfiguration, Error>
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
                    Section {
                        Text("Check your email for known data breaches").font(.headline)
                        Text("Verify an email address to see its known breach count. Details and ongoing monitoring will require a subscription.")
                        if !model.isSignedIn { Button("Get started / Sign in") { showSignIn = true } }
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
                                Text("Source: paid XposedOrNot (xonAPI+)").font(.footnote)
                                if model.account?.tier == "premium" {
                                    NavigationLink("Remediation dashboard") { FindingsView(model: model) }
                                } else { NavigationLink("Unlock breach details") { SubscriptionView() } }
                            } else { Text("Your email is verified. Run your first scan to see its known breach count.") }
                            Button(model.isScanning ? "Scanning…" : "Scan verified email") { Task { await model.scan() } }
                                .disabled(model.isBusy || model.isPaused(address))
                            if model.isPaused(address) { Text("This address is paused above your current plan quota.") }
                            if model.isScanning { ProgressView("Querying breach provider…") }
                        } else if model.isSignedIn {
                            Text("Your account could not be loaded.")
                            Button("Retry loading account") { Task { await model.reloadAccount() } }.disabled(model.isBusy)
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
                                        Button("Remove address", role: .destructive) { removingAddress = address }.disabled(model.isBusy)
                                    }
                                }.buttonStyle(.borderless)
                            }
                            Text("\(model.addresses.count) of \(account.quota) addresses on your \(account.tier) plan.")
                            Button("Add an email address") { showAddAddress = true }
                                .disabled(model.isBusy || account.tier != "premium" || model.addresses.count >= account.quota)
                            Button("Refresh addresses") { Task { await model.reloadAccount() } }.disabled(model.isBusy)
                            errorMessage
                        } else {
                            Text("Sign in to verify your first address.")
                            Button("Verify an email address") { showSignIn = true }.disabled(model.isBusy || model.isSignedIn)
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
                    Section("Daily monitoring") {
                        if let address = model.selectedAddress {
                            Text(address.email)
                            if let status = model.monitoring {
                                LabeledContent("Status", value: status.paused ? "Paused by plan" : status.enabled ? "Enabled" : "Disabled")
                                if let last = status.lastCheckedAt { Text("Last successful check: \(displayDate(last))") }
                                if let next = status.nextCheckAt, status.enabled && !status.paused {
                                    Text("Next check due: \(Date(timeIntervalSince1970: Double(next)).formatted(date: .abbreviated, time: .shortened))")
                                }
                                if let outcome = status.outcome, outcome != "success", outcome != "disabled", outcome != "pending" {
                                    Text("Last check did not complete. The backend retries temporary failures; your previous results remain available.")
                                }
                                Button(status.enabled ? "Disable daily monitoring" : "Enable daily monitoring") {
                                    Task { await model.setMonitoring(enabled: !status.enabled) }
                                }.disabled(model.isBusy || (!status.enabled && (model.account?.tier != "premium" || model.isPaused(address))))
                            }
                            Button("Refresh monitoring status") { Task { await model.reloadMonitoring() } }.disabled(model.isBusy)
                        } else { Text("Sign in and select a verified email first.") }
                        Text("Opt in to checking this verified address with XON about once daily. Existing findings form a historical baseline. Newly observed breaches are flagged in your dashboard; this is not real-time detection.")
                        NavigationLink("View subscription options") { SubscriptionView() }
                        errorMessage
                    }
                    Section("Notifications") {
                        Text("Push delivery is not configured. When available, alerts will say “New security finding — open the app to review.”")
                    }
                }
                .navigationTitle("Monitoring")
                .task(id: model.selectedAddress?.id) { await model.reloadMonitoring() }
            }
            .tabItem { Label("Monitoring", systemImage: "bell") }

            NavigationStack {
                List {
                    Section("Account") {
                        LabeledContent("Status", value: model.isSignedIn ? "Signed in" : "Signed out")
                        if let account = model.account { Text(account.address.email) }
                        if model.isSignedIn {
                            NavigationLink("Signed-in devices and sessions") { SessionsView(model: model) }
                            Button("Sign out") { Task { await model.logout() } }.disabled(model.isBusy)
                            Button("Delete account", role: .destructive) { confirmDeletion = true }.disabled(model.isBusy)
                        } else { Button("Sign in") { showSignIn = true }.disabled(model.isBusy) }
                        NavigationLink("Subscription") { SubscriptionView() }
                        errorMessage
                    }
                    Section("Privacy and help") {
                        Link("Email support", destination: URL(string: "mailto:security@cybrguard.app?subject=CybrGuard%20support")!)
                        NavigationLink("Privacy") {
                            InformationView(title: "Privacy", paragraphs: [
                                "Cloudflare Email Service receives your email to deliver a one-time verification code. After you verify and consent, the backend sends the verified address to the paid XposedOrNot (xonAPI+) service.",
                                "The backend encrypts your email at rest and stores its verified status, consent time, last successful breach count and scan time. For premium access, individual breach details are encrypted at rest and your remediation marks are stored. Verification codes are hashed, expire after 10 minutes and are removed during later sign-in requests after expiry. Session tokens are stored in your device Keychain; codes are not saved by the app.",
                                "Account deletion removes the stored account, email, results, verification challenges and sessions from CybrGuard. It does not erase historical records at the breach provider or email-provider delivery records.",
                                "This is a development notice. Production retention, privacy policy and terms require review before launch."
                            ])
                        }
                        NavigationLink("Terms") {
                            InformationView(title: "Terms", paragraphs: [
                                "Terms of service require review before launch. Purchases, trials and ongoing monitoring are not currently available.",
                                "Breach monitoring provides information about known historical exposures. It cannot prevent breaches or guarantee that an account is safe."
                            ])
                        }
                        NavigationLink("Help") {
                            InformationView(title: "Help", paragraphs: [
                                "Enter your email, consent to the provider query and request a verification code. Enter the six-digit (XXX-XXX) code from your inbox within 10 minutes. Each code can be used once; after five incorrect attempts request a new code.",
                                "Once verified, tap Scan verified email. Re-scans are limited to once per minute. Provider errors preserve the last successful result.",
                                "The local API must be running. A physical iPhone needs a reachable HTTPS backend; localhost only reaches your Mac in the simulator."
                            ])
                        }
                    }
                    Section("Development") {
                        NavigationLink("API connection") {
                            DevelopmentStatusView(brandName: brandName, configuration: configuration)
                        }
                    }
                }
                .navigationTitle("Settings")
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .task { await model.restore() }
        .sheet(isPresented: $showSignIn, onDismiss: { model.cancelVerification() }) { SignInView(model: model) }
        .sheet(isPresented: $showAddAddress, onDismiss: { model.cancelAddressVerification() }) { SignInView(model: model, additional: true) }
        .confirmationDialog("Remove this address and its stored findings?", isPresented: Binding(get: { removingAddress != nil }, set: { if !$0 { removingAddress = nil } }), titleVisibility: .visible) {
            if let address = removingAddress {
                Button("Remove address", role: .destructive) { Task { await model.removeAddress(address); removingAddress = nil } }
            }
        }
        .confirmationDialog("Delete your CybrGuard account and stored data?", isPresented: $confirmDeletion, titleVisibility: .visible) {
            Button("Delete account permanently", role: .destructive) { Task { await model.deleteAccount() } }
        } message: { Text("Your email, findings, remediation marks, scan count and sessions will be removed. Historical breach records at XON will remain.") }
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
                            Button("Sign out this session", role: .destructive) { Task { await model.revokeSession(session) } }.disabled(model.isBusy)
                        }
                    }.buttonStyle(.borderless)
                }
                Button("Refresh sessions") { Task { await model.reloadSessions() } }.disabled(model.isBusy)
                Button("Sign out all other sessions", role: .destructive) { confirmOthers = true }.disabled(model.isBusy || model.sessions.count < 2)
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
                    Toggle(additional ? "The mailbox owner consents to verification and breach queries with XposedOrNot (xonAPI+)." : "I consent to querying my verified email with XposedOrNot (xonAPI+) for known breaches.", isOn: $consent)
                    Text("Cloudflare Email Service delivers the verification code. Only after verification will your address be sent to XON.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button(model.isBusy ? "Sending…" : "Send verification code") {
                        Task { if await (additional ? model.startAddress(email: email) : model.start(email: email)) { showVerification = true } }
                    }.disabled(!validEmail || !consent || model.isBusy)
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
                }.disabled(VerificationCode.digits(code).count != 6 || model.isBusy)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Button("Resend code") {
                        Task {
                            if await (additional ? model.startAddress(email: email) : model.start(email: email)) {
                                resendAfter = Date().addingTimeInterval(60)
                                code = ""
                            }
                        }
                    }.disabled(context.date < resendAfter || model.isBusy)
                }
                if model.isBusy { ProgressView() }
                if let message = model.message { Text(message).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Enter code")
    }
}

private struct SubscriptionView: View {
    var body: some View {
        List {
            Section("Free") { Text("Known breach count for one verified email and basic security guidance.") }
            Section("Personal") { Text("Planned: up to 3 verified addresses, breach details, monitoring and remediation tracking.") }
            Section("Family") { Text("Planned: up to 15 independently verified addresses, with each person's consent.") }
            Section("Purchases unavailable") {
                Text("Prices, billing periods and trial terms will come from the App Store. Purchases are not connected yet. Premium breach details are available to approved test accounts.")
                Button("Subscribe") {}.disabled(true)
                Button("Restore purchases") {}.disabled(true)
                Link("Manage Apple subscriptions", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
            }
            Section { Text("Sign-in, free access and account deletion do not require a purchase.") }
        }.navigationTitle("Subscription")
    }
}

private struct InformationView: View {
    let title: String
    let paragraphs: [String]
    var body: some View {
        List { ForEach(paragraphs, id: \.self) { Text($0) } }.navigationTitle(title)
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
            if model.account?.tier != "premium" {
                Text("Premium access is required. Purchases are not connected yet.")
            } else if model.isBusy && model.findings.isEmpty {
                ProgressView("Loading findings…")
            } else if model.findings.isEmpty {
                Text(model.findingsCheckedAt == nil ? "Run a new scan to load detailed findings." : "No known breaches were returned by the last detailed scan.")
            }
            if model.account?.tier == "premium" {
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
                                .disabled(model.isBusy)
                                Text(step.detail).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        if let date = finding.remediatedAt {
                            Label("Remediated (self-reported) · \(remediationDate(date))", systemImage: "checkmark.circle")
                        }
                        Button(finding.remediatedAt == nil ? "Mark as remediated" : "Undo remediation mark") {
                            Task { await model.setRemediated(finding, remediated: finding.remediatedAt == nil) }
                        }.disabled(model.isBusy)
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
