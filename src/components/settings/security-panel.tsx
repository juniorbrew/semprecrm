'use client';

import { MfaCard, MfaRequiredNotice } from './mfa-card';
import { PasswordForm } from './password-form';
import { SessionsCard } from './sessions-card';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * "Login e segurança" section — groups the former Profile-tab password
 * and active-sessions cards into their own dedicated home.
 */
export function SecurityPanel() {
  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Login e segurança"
        description="Change your password and sign out of your devices. These keep your account safe."
      />
      <MfaRequiredNotice />
      <div className="space-y-4">
        <MfaCard />
        <PasswordForm />
        <SessionsCard />
      </div>
    </section>
  );
}
