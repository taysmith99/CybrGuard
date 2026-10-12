import { describe, expect, it } from 'vitest';
import { remediationSteps } from '../src/lib/remediation';

const finding = {
  breachId: 'Fictional',
  breachedAt: null,
  domain: null,
  exposedData: [] as string[],
  passwordRisk: null,
  passwordRiskHighlighted: false,
  description: null,
};
describe('evidence-based remediation guidance', () => {
  it('does not invent exposed credentials for unknown data', () => {
    expect(remediationSteps(finding).map((step) => step.id)).toEqual(['review-account']);
  });
  it('matches exposed categories and password risk without relying on descriptions', () => {
    const steps = remediationSteps({
      ...finding,
      exposedData: ['Email addresses', 'Telephone numbers', 'Credit cards', 'Dates of birth'],
      passwordRiskHighlighted: true,
    });
    expect(steps.map((step) => step.id)).toEqual([
      'review-account',
      'change-password',
      'enable-mfa',
      'watch-phishing',
      'protect-mobile',
      'review-payments',
      'review-identity',
    ]);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
    expect(
      remediationSteps({ ...finding, description: 'Passwords were not exposed' }).map(
        (step) => step.id,
      ),
    ).not.toContain('change-password');
  });
});
