import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, KeyRound, LogIn, LogOut, RefreshCw, ShieldCheck, Sparkles, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

type AuthFormMode = 'login' | 'register';

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function ProviderStatusPill({ mode }: { mode: 'personal' | 'workspace' | 'sandbox' }) {
  const tone = mode === 'personal'
    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
    : mode === 'workspace'
      ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20'
      : 'bg-amber-500/10 text-amber-300 border-amber-500/20';

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest ${tone}`}>
      {mode}
    </span>
  );
}

export function AccountDashboard() {
  const {
    isAuthenticated,
    user,
    provider,
    sessions,
    auditEvents,
    capabilities,
    identity,
    pendingTwoFactorChallenge,
    twoFactorSetup,
    login,
    register,
    verifyTwoFactor,
    clearTwoFactorChallenge,
    beginGoogleSignIn,
    disconnectGoogleIdentity,
    beginTwoFactorSetup,
    confirmTwoFactorSetup,
    disableTwoFactor,
    logout,
    linkGeminiProvider,
    disconnectGeminiProvider,
    revokeSession,
  } = useAuth();

  const [mode, setMode] = useState<AuthFormMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorDisableCode, setTwoFactorDisableCode] = useState('');
  const [providerLabel, setProviderLabel] = useState('My Gemini Project');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [dailyVideoLimit, setDailyVideoLimit] = useState('3');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLinkingProvider, setIsLinkingProvider] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [isManagingTwoFactor, setIsManagingTwoFactor] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('authResult');
    const authError = params.get('authError');

    if (authResult === 'google-login-success') {
      setMessage('Google sign-in completed successfully.');
    } else if (authResult === 'google-link-success') {
      setMessage('Google sign-in was linked to your StoryForge account.');
    } else if (authError) {
      setError(decodeURIComponent(authError));
    }

    if (authResult || authError) {
      params.delete('authResult');
      params.delete('authError');
      const nextQuery = params.toString();
      window.history.replaceState({}, document.title, `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`);
    }
  }, []);

  const capabilityItems = useMemo(() => ([
    {
      label: 'Cloud sync',
      enabled: capabilities.cloudSync,
      summary: capabilities.cloudSync ? 'Account-scoped project sync is enabled.' : 'Sign in to sync projects securely across sessions.',
    },
    {
      label: 'AI tools',
      enabled: capabilities.aiTools,
      summary: capabilities.aiTools ? 'Authenticated AI routes are available to this account.' : 'Sign in to unlock authenticated AI text and video routes.',
    },
    {
      label: 'Google OIDC',
      enabled: capabilities.googleOidc,
      summary: capabilities.googleOidc ? 'Google sign-in is configured for this workspace.' : 'Set GOOGLE_OIDC_CLIENT_ID and GOOGLE_OIDC_CLIENT_SECRET to enable Google sign-in.',
    },
    {
      label: 'Local 2FA',
      enabled: capabilities.localTwoFactor,
      summary: capabilities.localTwoFactor ? 'TOTP-based 2FA can protect local password sign-in.' : 'Local 2FA becomes available after you sign in with a password-capable account.',
    },
  ]), [capabilities]);

  const handleSubmitAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      if (mode === 'register') {
        await register({ name, email, password });
        setMessage('Account created and signed in. Cloud sync, authenticated generation, and optional 2FA are now available.');
      } else {
        const result = await login({ email, password });
        setMessage(result ? 'Signed in successfully. Your secure workspace session is active.' : 'Password verified. Enter the 2FA code from your authenticator app to finish signing in.');
      }
      setPassword('');
    } catch (authError: any) {
      setError(authError?.message || 'Authentication failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerifyTwoFactor = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pendingTwoFactorChallenge) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      await verifyTwoFactor({
        challengeId: pendingTwoFactorChallenge.challengeId,
        token: twoFactorCode,
      });
      setTwoFactorCode('');
      setMessage('2FA verified. Your secure workspace session is active.');
    } catch (twoFactorError: any) {
      setError(twoFactorError?.message || '2FA verification failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLinkProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLinkingProvider(true);
    setError(null);
    setMessage(null);

    try {
      await linkGeminiProvider({
        label: providerLabel,
        apiKey: providerApiKey,
        dailyVideoLimit: Number(dailyVideoLimit) || 3,
      });
      setProviderApiKey('');
      setMessage('Personal Gemini API access connected. Future live renders will use this account-specific provider.');
    } catch (providerError: any) {
      setError(providerError?.message || 'Provider connection failed.');
    } finally {
      setIsLinkingProvider(false);
    }
  };

  const handleDisconnectProvider = async () => {
    setError(null);
    setMessage(null);

    try {
      await disconnectGeminiProvider();
      setMessage('Personal Gemini provider disconnected. StoryForge will fall back to the workspace provider or sandbox mode.');
    } catch (providerError: any) {
      setError(providerError?.message || 'Provider disconnect failed.');
    }
  };

  const handleDisconnectGoogle = async () => {
    setError(null);
    setMessage(null);

    try {
      await disconnectGoogleIdentity();
      setMessage('Google sign-in was removed from this account.');
    } catch (providerError: any) {
      setError(providerError?.message || 'Google unlink failed.');
    }
  };

  const handleStartTwoFactorSetup = async () => {
    setIsManagingTwoFactor(true);
    setError(null);
    setMessage(null);
    try {
      await beginTwoFactorSetup();
      setMessage('Scan the QR code with your authenticator app, then enter the current code to enable 2FA.');
    } catch (twoFactorError: any) {
      setError(twoFactorError?.message || 'Could not start 2FA setup.');
    } finally {
      setIsManagingTwoFactor(false);
    }
  };

  const handleConfirmTwoFactorSetup = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsManagingTwoFactor(true);
    setError(null);
    setMessage(null);
    try {
      await confirmTwoFactorSetup(twoFactorCode);
      setTwoFactorCode('');
      setMessage('Two-factor authentication is now enabled for local password sign-in.');
    } catch (twoFactorError: any) {
      setError(twoFactorError?.message || 'Could not enable 2FA.');
    } finally {
      setIsManagingTwoFactor(false);
    }
  };

  const handleDisableTwoFactor = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsManagingTwoFactor(true);
    setError(null);
    setMessage(null);
    try {
      await disableTwoFactor(twoFactorDisableCode);
      setTwoFactorDisableCode('');
      setMessage('Two-factor authentication was disabled for local password sign-in.');
    } catch (twoFactorError: any) {
      setError(twoFactorError?.message || 'Could not disable 2FA.');
    } finally {
      setIsManagingTwoFactor(false);
    }
  };

  const handleLogout = async () => {
    setError(null);
    setMessage(null);

    try {
      await logout();
      setMessage('Signed out. Your local draft remains available on this device.');
    } catch (logoutError: any) {
      setError(logoutError?.message || 'Sign out failed.');
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    setRevokingSessionId(sessionId);
    setError(null);
    setMessage(null);

    try {
      await revokeSession(sessionId);
      setMessage('Selected session revoked.');
    } catch (sessionError: any) {
      setError(sessionError?.message || 'Session revoke failed.');
    } finally {
      setRevokingSessionId(null);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div>
        <h2 className="text-lg font-medium tracking-tight text-white">Account & Security</h2>
        <p className="text-[11px] text-zinc-500 font-mono mt-0.5">
          Password login, Google OIDC, local TOTP-based 2FA, session controls, and Gemini provider isolation.
        </p>
      </div>

      {(message || error) && (
        <div className={`rounded-2xl border p-3 text-sm ${error ? 'border-red-500/10 bg-red-500/5 text-red-300' : 'border-emerald-500/10 bg-emerald-500/5 text-emerald-300'}`}>
          {error || message}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="bg-zinc-900/50 border border-zinc-900 rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-white">Workspace identity</h3>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                StoryForge keeps app identity separate from Gemini provider credentials and now supports Google OIDC alongside local password login.
              </p>
            </div>
            <ProviderStatusPill mode={provider.mode} />
          </div>

          {!isAuthenticated ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-amber-500/10 bg-amber-500/5 p-4 text-sm text-zinc-300 leading-relaxed">
                <div className="flex items-center gap-2 text-amber-300 font-semibold mb-2">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Local mode is active</span>
                </div>
                <p>
                  You can still edit local drafts, but secure cloud sync and authenticated AI/video routes stay locked until you sign in.
                </p>
              </div>

              {pendingTwoFactorChallenge ? (
                <form onSubmit={handleVerifyTwoFactor} className="space-y-3 rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4">
                  <div>
                    <div className="text-sm font-semibold text-white">Two-factor verification</div>
                    <div className="mt-1 text-xs text-zinc-400">
                      Password verified for {pendingTwoFactorChallenge.email}. Enter the current 6-digit code from your authenticator app before {formatDateTime(pendingTwoFactorChallenge.expiresAt)}.
                    </div>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Authenticator code</span>
                    <input
                      value={twoFactorCode}
                      onChange={(event) => setTwoFactorCode(event.target.value)}
                      className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                      placeholder="123456"
                      inputMode="numeric"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      disabled={isSubmitting || !twoFactorCode.trim()}
                      className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-xl flex items-center gap-2"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>{isSubmitting ? 'Verifying…' : 'Verify 2FA code'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clearTwoFactorChallenge();
                        setTwoFactorCode('');
                      }}
                      className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm font-semibold px-4 py-2 rounded-xl"
                    >
                      Back to sign in
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex gap-2 rounded-xl bg-zinc-950 border border-zinc-900 p-1 w-fit">
                    <button
                      type="button"
                      onClick={() => setMode('login')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${mode === 'login' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-100'}`}
                    >
                      Sign in
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode('register')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${mode === 'register' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-100'}`}
                    >
                      Create account
                    </button>
                  </div>

                  <form onSubmit={handleSubmitAuth} className="space-y-3">
                    {mode === 'register' && (
                      <label className="block space-y-1">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Display name</span>
                        <input
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                          placeholder="StoryForge Operator"
                        />
                      </label>
                    )}

                    <label className="block space-y-1">
                      <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Email</span>
                      <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                        placeholder="operator@storyforge.dev"
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Password</span>
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                        placeholder="At least 8 characters"
                      />
                    </label>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-xl flex items-center gap-2"
                      >
                        <LogIn className="w-4 h-4" />
                        <span>{isSubmitting ? 'Working…' : mode === 'register' ? 'Create secure account' : 'Sign in securely'}</span>
                      </button>

                      {identity.googleOidcConfigured && (
                        <button
                          type="button"
                          onClick={() => beginGoogleSignIn('login')}
                          className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-100 text-sm font-semibold px-4 py-2 rounded-xl inline-flex items-center gap-2"
                        >
                          <Sparkles className="w-4 h-4" />
                          <span>Continue with Google</span>
                        </button>
                      )}
                    </div>
                  </form>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-zinc-100 font-semibold">
                    <User className="w-4 h-4 text-indigo-400" />
                    <span>{user?.name}</span>
                  </div>
                  <p className="text-sm text-zinc-400">{user?.email}</p>
                  <p className="text-[11px] font-mono text-zinc-500">Joined {formatDateTime(user?.createdAt)}</p>
                </div>

                <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-zinc-100 font-semibold">
                    <Cloud className="w-4 h-4 text-emerald-400" />
                    <span>Access summary</span>
                  </div>
                  <p className="text-sm text-zinc-400 leading-relaxed">{provider.note}</p>
                  <p className="text-[11px] font-mono text-zinc-500">
                    {provider.dailyVideoLimit !== null
                      ? `${provider.remainingToday ?? 0} of ${provider.dailyVideoLimit} live video generations remaining today`
                      : 'No per-user daily limit is currently enforced for this provider.'}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4 space-y-2">
                  <div className="text-sm font-semibold text-zinc-100">Sign-in methods</div>
                  <div className="text-xs text-zinc-400 leading-relaxed">
                    Local password: <span className="text-zinc-200">{identity.passwordLoginEnabled ? 'enabled' : 'not configured'}</span><br />
                    Google OIDC: <span className="text-zinc-200">{identity.googleLinked ? 'linked' : (identity.googleOidcConfigured ? 'available to link' : 'not configured')}</span><br />
                    Local 2FA: <span className="text-zinc-200">{identity.twoFactorEnabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {identity.googleOidcConfigured && !identity.googleLinked && (
                      <button
                        type="button"
                        onClick={() => beginGoogleSignIn('link')}
                        className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-100 text-xs font-semibold px-3 py-2 rounded-xl"
                      >
                        Link Google sign-in
                      </button>
                    )}
                    {identity.googleLinked && (
                      <button
                        type="button"
                        onClick={handleDisconnectGoogle}
                        disabled={!identity.passwordLoginEnabled}
                        className="bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 border border-zinc-700 text-zinc-100 text-xs font-semibold px-3 py-2 rounded-xl"
                      >
                        Disconnect Google
                      </button>
                    )}
                  </div>
                  {identity.googleLinked && !identity.passwordLoginEnabled && (
                    <div className="text-[11px] text-amber-300">
                      Google cannot be disconnected until a password-based sign-in method exists for this account.
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4 space-y-3">
                  <div className="text-sm font-semibold text-zinc-100">Local 2FA</div>
                  {!identity.passwordLoginEnabled ? (
                    <div className="text-xs text-zinc-500 leading-relaxed">
                      Local TOTP-based 2FA is only available for accounts that use password login.
                    </div>
                  ) : twoFactorSetup ? (
                    <form onSubmit={handleConfirmTwoFactorSetup} className="space-y-3">
                      <img src={twoFactorSetup.qrCodeDataUrl} alt="2FA QR code" className="w-44 h-44 rounded-2xl border border-zinc-900 bg-white p-2" />
                      <div className="rounded-2xl border border-zinc-900 bg-zinc-900/40 p-3 text-[11px] font-mono text-zinc-400 break-all">
                        Manual key: {twoFactorSetup.manualEntryKey}
                      </div>
                      <label className="block space-y-1">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Authenticator code</span>
                        <input
                          value={twoFactorCode}
                          onChange={(event) => setTwoFactorCode(event.target.value)}
                          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                          placeholder="123456"
                          inputMode="numeric"
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="submit"
                          disabled={isManagingTwoFactor || !twoFactorCode.trim()}
                          className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold px-3 py-2 rounded-xl"
                        >
                          {isManagingTwoFactor ? 'Enabling…' : 'Enable 2FA'}
                        </button>
                      </div>
                    </form>
                  ) : identity.twoFactorEnabled ? (
                    <form onSubmit={handleDisableTwoFactor} className="space-y-3">
                      <div className="text-xs text-zinc-400 leading-relaxed">
                        2FA is active for password sign-in. Enter a current authenticator code if you need to disable it.
                      </div>
                      <label className="block space-y-1">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Current 2FA code</span>
                        <input
                          value={twoFactorDisableCode}
                          onChange={(event) => setTwoFactorDisableCode(event.target.value)}
                          className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                          placeholder="123456"
                          inputMode="numeric"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={isManagingTwoFactor || !twoFactorDisableCode.trim()}
                        className="bg-red-500/10 hover:bg-red-500/20 disabled:opacity-60 border border-red-500/20 text-red-300 text-xs font-semibold px-3 py-2 rounded-xl"
                      >
                        {isManagingTwoFactor ? 'Disabling…' : 'Disable 2FA'}
                      </button>
                    </form>
                  ) : (
                    <div className="space-y-3">
                      <div className="text-xs text-zinc-400 leading-relaxed">
                        Add a TOTP authenticator app challenge after password verification for local sign-in.
                      </div>
                      <button
                        type="button"
                        onClick={handleStartTwoFactorSetup}
                        disabled={isManagingTwoFactor}
                        className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold px-3 py-2 rounded-xl"
                      >
                        {isManagingTwoFactor ? 'Preparing…' : 'Set up 2FA'}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-100 text-xs font-semibold px-3 py-2 rounded-xl inline-flex items-center gap-1.5"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign out</span>
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="bg-zinc-900/50 border border-zinc-900 rounded-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-white">Capability map</h3>
          </div>
          <div className="space-y-3">
            {capabilityItems.map((item) => (
              <div key={item.label} className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-zinc-100">{item.label}</div>
                  <span className={`text-[10px] font-mono uppercase tracking-widest ${item.enabled ? 'text-emerald-300' : 'text-zinc-500'}`}>
                    {item.enabled ? 'enabled' : 'locked'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-400 leading-relaxed">{item.summary}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {isAuthenticated && (
        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <section className="bg-zinc-900/50 border border-zinc-900 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-indigo-400" />
                  <span>Generation provider</span>
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed mt-1">
                  Link a personal Gemini API key to isolate Veo usage from any shared workspace credential. Keys are stored server-side only.
                </p>
              </div>
              <ProviderStatusPill mode={provider.mode} />
            </div>

            <div className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-4 space-y-2">
              <div className="text-sm font-semibold text-zinc-100">{provider.label}</div>
              <div className="text-xs text-zinc-400">{provider.note}</div>
              <div className="grid gap-2 sm:grid-cols-2 text-[11px] font-mono text-zinc-500">
                <div>Connected: {formatDateTime(provider.connectedAt)}</div>
                <div>Key: {provider.maskedApiKey || 'Not applicable'}</div>
                <div>Used today: {provider.usedToday}</div>
                <div>Remaining: {provider.remainingToday ?? 'n/a'}</div>
              </div>
              {provider.mode === 'personal' && (
                <button
                  type="button"
                  onClick={handleDisconnectProvider}
                  className="mt-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 text-xs font-semibold px-3 py-2 rounded-xl"
                >
                  Disconnect personal provider
                </button>
              )}
            </div>

            <form onSubmit={handleLinkProvider} className="space-y-3">
              <label className="block space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Connection label</span>
                <input
                  value={providerLabel}
                  onChange={(event) => setProviderLabel(event.target.value)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                  placeholder="My Gemini Project"
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Gemini API key</span>
                <input
                  type="password"
                  value={providerApiKey}
                  onChange={(event) => setProviderApiKey(event.target.value)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                  placeholder="AIza..."
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Daily live video limit</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={dailyVideoLimit}
                  onChange={(event) => setDailyVideoLimit(event.target.value)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                />
              </label>

              <button
                type="submit"
                disabled={isLinkingProvider || !providerApiKey.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-xl inline-flex items-center gap-2"
              >
                <KeyRound className="w-4 h-4" />
                <span>{isLinkingProvider ? 'Connecting…' : 'Connect personal Gemini API key'}</span>
              </button>
            </form>
          </section>

          <section className="space-y-4">
            <div className="bg-zinc-900/50 border border-zinc-900 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-white">Active sessions</h3>
              </div>

              <div className="space-y-3">
                {sessions.length ? sessions.map((session) => (
                  <div key={session.id} className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-zinc-100">
                          {session.isCurrent ? 'Current session' : 'Trusted session'}
                        </div>
                        <div className="text-xs text-zinc-500 font-mono">{session.ipPreview || 'current device'}</div>
                      </div>
                      {!session.isCurrent && (
                        <button
                          type="button"
                          onClick={() => handleRevokeSession(session.id)}
                          disabled={revokingSessionId === session.id}
                          className="bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-100 text-xs font-semibold px-3 py-1.5 rounded-xl disabled:opacity-50"
                        >
                          {revokingSessionId === session.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-500 font-mono leading-relaxed">
                      <div>Created: {formatDateTime(session.createdAt)}</div>
                      <div>Last seen: {formatDateTime(session.lastSeenAt)}</div>
                      <div>Expires: {formatDateTime(session.expiresAt)}</div>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm text-zinc-500">No active sessions found.</div>
                )}
              </div>
            </div>

            <div className="bg-zinc-900/50 border border-zinc-900 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-white">Recent account activity</h3>
              </div>

              <div className="space-y-3">
                {auditEvents.length ? auditEvents.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-zinc-900 bg-zinc-950/80 p-3">
                    <div className="text-sm font-semibold text-zinc-100">{event.detail}</div>
                    <div className="text-[11px] font-mono text-zinc-500 mt-1">{event.type} · {formatDateTime(event.createdAt)}</div>
                  </div>
                )) : (
                  <div className="text-sm text-zinc-500">No recent account events yet.</div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
