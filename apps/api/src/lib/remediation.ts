import type { BreachDetails } from '@cybrguard/contracts';

// Deterministic guidance based only on reported data categories, not a diagnosis
// of current compromise. Never request passwords or claim an action was verified.
export function remediationSteps(finding: BreachDetails) {
  const data = finding.exposedData.join(' ').toLowerCase();
  const steps = [
    {
      id: 'review-account',
      title: 'Review the affected account',
      detail:
        'Open the service using its official app or a known bookmark. Review recent activity and security settings.',
    },
  ];
  if (/password|credential/.test(data) || finding.passwordRiskHighlighted) {
    steps.push(
      {
        id: 'change-password',
        title: 'Replace affected and reused passwords',
        detail:
          'Choose a unique password for this account. Replace the same password anywhere else you used it; a password manager can help.',
      },
      {
        id: 'enable-mfa',
        title: 'Enable multi-factor authentication',
        detail:
          'If the service supports it, enable a passkey, authenticator or another available second factor and keep recovery codes somewhere safe.',
      },
    );
  }
  if (/email|phone|telephone/.test(data)) {
    steps.push({
      id: 'watch-phishing',
      title: 'Watch for targeted phishing',
      detail:
        'Be cautious of unexpected calls, messages and sign-in links. Go directly to the service rather than following a message link; never share verification codes.',
    });
  }
  if (/phone|telephone/.test(data)) {
    steps.push({
      id: 'protect-mobile',
      title: 'Review mobile account protection',
      detail:
        'Ask your mobile provider about an account PIN and protections against unauthorised number transfers.',
    });
  }
  if (/credit|debit|payment|bank|financial/.test(data)) {
    steps.push({
      id: 'review-payments',
      title: 'Review affected payment accounts',
      detail:
        'Check recent transactions. Contact your bank or card issuer using its official contact details if you notice unfamiliar activity or need advice about exposed payment information.',
    });
  }
  if (/birth|address|passport|licen[cs]e|identity|social security/.test(data)) {
    steps.push({
      id: 'review-identity',
      title: 'Review identity information exposure',
      detail:
        'Consider which reported identity details are still current. Watch for unfamiliar account activity and use official identity-support services if you suspect misuse.',
    });
  }
  return steps;
}
