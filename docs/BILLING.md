# Billing implementation plan

Billing is not implemented in this local scan vertical slice. There is no RevenueCat SDK, webhook, App Store product or working purchase flow. Detailed findings are enforced against server-side expiring entitlements, with a separate staging-only tester override; neither is proof of a purchase.

The brief proposes free, Personal and Family tiers with independently verified address quotas. Its AUD prices are proposals, not configured store products. Use localised StoreKit/RevenueCat product information in a future paywall; do not hard-code advertised pricing or trust a client premium flag.

## Implementation and manual configuration

1. Choose the final bundle identifier and configure the application and subscription products in App Store Connect.
2. Create a RevenueCat project and connect the Apple app; add its iOS SDK using the [official installation guide](https://www.revenuecat.com/docs/getting-started/installation/ios).
3. Choose and document the final entitlement-to-plan mapping. The brief proposes `monitoring_personal` and `monitoring_family`, but no mapping has been implemented or provisioned.
4. Configure products, packages, offerings and any trial in the provider dashboards, and create sandbox test accounts.
5. Implement authenticated, idempotent [RevenueCat webhook handling](https://www.revenuecat.com/docs/integrations/webhooks), server-side customer mapping and reconciliation before configuring the webhook URL. Keep server credentials out of the app.
6. Enforce current entitlements and quotas on the backend; implement restore purchases, subscription management, free login and clear renewal/trial disclosures.
7. Test purchase, restore, expiration, refund, grace period, downgrade, delayed event and duplicate event behaviour end to end.

The future iOS application uses Apple in-app purchases for its primary subscription flow. There is no Stripe checkout or separate web subscription implementation. Recheck applicable platform requirements during release preparation.
