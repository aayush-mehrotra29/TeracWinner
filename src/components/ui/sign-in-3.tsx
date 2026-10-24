"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Eye, EyeOff, LoaderCircle, LogOut, UserRound } from "lucide-react";

import ThreadLightCanvas from "@/components/ThreadLightCanvas";
import { createClient } from "@/lib/supabase/client";

type AuthMode = "sign-in" | "sign-up" | "forgot-password" | "update-password";

const pageCopy: Record<AuthMode, { title: string; description: string; action: string }> = {
  "sign-in": {
    title: "Sign in to your account",
    description: "Enter your details to sign in.",
    action: "Sign in",
  },
  "sign-up": {
    title: "Create your account",
    description: "Get started with your email and password.",
    action: "Create account",
  },
  "forgot-password": {
    title: "Reset your password",
    description: "We’ll send a reset link to your email.",
    action: "Send reset link",
  },
  "update-password": {
    title: "Choose a new password",
    description: "Your new password must be at least 8 characters.",
    action: "Update password",
  },
};

function modeFromUrl(): AuthMode {
  const value = new URLSearchParams(window.location.search).get("mode");
  if (
    value === "sign-up" ||
    value === "forgot-password" ||
    value === "update-password"
  ) {
    return value;
  }
  return "sign-in";
}

function callbackErrorFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("error") === "missing-code") {
    return "This sign-in link is invalid or has expired. Please try again.";
  }
  if (params.get("error") === "callback-failed") {
    return "We couldn't finish signing you in. Please try again.";
  }
  if (new URLSearchParams(window.location.hash.slice(1)).has("error")) {
    return "We couldn't finish signing you in. Please try again.";
  }
  return null;
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="auth-google-mark">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.27 5.48-4.8 7.18l7.73 6C44.38 38.03 46.98 31.69 46.98 24.55Z" />
      <path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.6.28-3.13.77-4.59l-7.98-6.2A23.88 23.88 0 0 0 0 24c0 3.87.93 7.51 2.56 10.78l7.97-6.19Z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.14 1.44-4.89 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" />
    </svg>
  );
}

export default function SignIn() {
  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
      clientRef.current = client;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Authentication is unavailable.";
      Promise.resolve().then(() => {
        if (!active) return;
        setError(message);
        setReady(true);
      });
      return () => {
        active = false;
      };
    }

    const updateModeFromUrl = () => {
      if (active) {
        setMode(modeFromUrl());
        setError(callbackErrorFromUrl());
      }
    };
    window.addEventListener("popstate", updateModeFromUrl);

    const { data: { subscription } } = client.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") {
        window.history.replaceState(null, "", "/?mode=update-password");
        setMode("update-password");
      }
    });

    client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      setMode(modeFromUrl());
      setSession(data.session);
      setError(sessionError?.message ?? callbackErrorFromUrl());
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Could not load your session.");
    }).finally(() => {
      if (active) {
        setConfigured(true);
        setReady(true);
      }
    });

    return () => {
      active = false;
      window.removeEventListener("popstate", updateModeFromUrl);
      subscription.unsubscribe();
    };
  }, []);

  function navigateMode(nextMode: AuthMode) {
    const nextUrl = nextMode === "sign-in" ? "/" : `/?mode=${nextMode}`;
    window.history.pushState(null, "", nextUrl);
    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = clientRef.current;
    if (!client || pending) return;
    setError(null);
    setNotice(null);

    if ((mode === "sign-up" || mode === "update-password") && password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if ((mode === "sign-up" || mode === "update-password") && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setPending(true);
    try {
      if (mode === "sign-in") {
        const { error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (authError) throw authError;
        setPassword("");
      } else if (mode === "sign-up") {
        const { data, error: authError } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (authError) throw authError;
        setPassword("");
        setConfirmPassword("");
        if (!data.session) {
          navigateMode("sign-in");
          setNotice("Check your email for a confirmation link, then sign in.");
        }
      } else if (mode === "forgot-password") {
        const next = encodeURIComponent("/?mode=update-password");
        const { error: authError } = await client.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/auth/callback?next=${next}`,
        });
        if (authError) throw authError;
        setNotice("If an account exists for this email, a reset link is on its way.");
      } else {
        const { error: authError } = await client.auth.updateUser({ password });
        if (authError) throw authError;
        navigateMode("sign-in");
        setNotice("Your password has been updated.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleGoogle() {
    const client = clientRef.current;
    if (!client || pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const { error: authError } = await client.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (authError) throw authError;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Google sign-in is unavailable.");
      setPending(false);
    }
  }

  async function handleSignOut() {
    const client = clientRef.current;
    if (!client || pending) return;
    setPending(true);
    setError(null);
    try {
      const { error: authError } = await client.auth.signOut();
      if (authError) throw authError;
      setSession(null);
      navigateMode("sign-in");
      setNotice("You have signed out.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally {
      setPending(false);
    }
  }

  const signedIn = Boolean(session) && mode !== "update-password";
  const recoveryExpired = ready && mode === "update-password" && !session;
  const copy = pageCopy[mode];

  return (
    <main className="auth-page" aria-label="TeracWinner account access">
      <section className="auth-form-panel">
        <div className="auth-brand" aria-label="TeracWinner">Terac<span>Winner</span><span className="auth-brand-dot" /></div>

        <div className="auth-content">
          <header className="auth-heading">
            <div className="auth-orb" aria-hidden="true"><div className="auth-orb-inner"><UserRound size={25} strokeWidth={1.8} /></div></div>
            <h1>{signedIn ? "You’re signed in" : recoveryExpired ? "Recovery link expired" : copy.title}</h1>
            <p>{signedIn ? "Your TeracWinner account is ready." : recoveryExpired ? "Request a new link to reset your password." : copy.description}</p>
          </header>

          {!ready ? (
            <div className="auth-loading" role="status"><LoaderCircle size={19} className="auth-spinner" /> Checking your session…</div>
          ) : (
            <>
              {error && <div className="auth-feedback auth-feedback-error" role="alert">{error}</div>}
              {notice && <div className="auth-feedback auth-feedback-info" role="status">{notice}</div>}

              {signedIn ? (
                <div className="auth-account">
                  <div className="auth-account-label">Signed in as</div>
                  <div className="auth-account-email">{session?.user.email ?? "Your account"}</div>
                  <a className="auth-text-link" href="/outreach">Open Orit email outreach</a>
                  <button className="auth-primary-button" type="button" onClick={handleSignOut} disabled={pending}>
                    {pending ? <LoaderCircle size={17} className="auth-spinner" aria-hidden="true" /> : <LogOut size={17} aria-hidden="true" />}
                    <span>{pending ? "Signing out…" : "Sign out"}</span>
                  </button>
                </div>
              ) : recoveryExpired ? (
                <div className="auth-account">
                  <button className="auth-primary-button" type="button" onClick={() => navigateMode("forgot-password")}>Request a new link</button>
                </div>
              ) : (
                <>
                  <form className="auth-form" onSubmit={handleSubmit}>
                    {mode !== "update-password" && (
                      <div className="auth-field">
                        <label htmlFor="auth-email">Email</label>
                        <input
                          id="auth-email"
                          name="email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          spellCheck={false}
                          placeholder="you@example.com"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          required
                          disabled={pending}
                        />
                      </div>
                    )}

                    {mode !== "forgot-password" && (
                      <div className="auth-field">
                        <div className="auth-label-row">
                          <label htmlFor="auth-password">{mode === "update-password" ? "New password" : "Password"}</label>
                          {mode === "sign-in" && <button className="auth-text-link" type="button" onClick={() => navigateMode("forgot-password")}>Forgot password?</button>}
                        </div>
                        <div className="auth-password-wrap">
                          <input
                            id="auth-password"
                            name="password"
                            type={showPassword ? "text" : "password"}
                            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                            placeholder="••••••••••"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            required
                            minLength={mode === "sign-in" ? undefined : 8}
                            disabled={pending}
                          />
                          <button className="auth-eye-button" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"} disabled={pending}>
                            {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                          </button>
                        </div>
                      </div>
                    )}

                    {(mode === "sign-up" || mode === "update-password") && (
                      <div className="auth-field">
                        <label htmlFor="auth-confirm-password">Confirm password</label>
                        <input
                          id="auth-confirm-password"
                          name="confirm-password"
                          type="password"
                          autoComplete="new-password"
                          placeholder="••••••••••"
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          required
                          minLength={8}
                          disabled={pending}
                        />
                      </div>
                    )}

                    <button className="auth-primary-button" type="submit" disabled={pending || !configured} aria-busy={pending}>
                      {pending && <LoaderCircle size={17} className="auth-spinner" aria-hidden="true" />}
                      <span>{pending ? "Please wait…" : copy.action}</span>
                    </button>
                  </form>

                  {(mode === "sign-in" || mode === "sign-up") && (
                    <>
                      <div className="auth-divider"><span>or continue with</span></div>
                      <button className="auth-google-button" type="button" onClick={handleGoogle} disabled={pending || !configured}>
                        <GoogleMark /><span>Continue with Google</span>
                      </button>
                    </>
                  )}

                  <div className="auth-switch">
                    {mode === "sign-in" ? <>Not a member yet? <button type="button" onClick={() => navigateMode("sign-up")}>Join now</button></>
                      : mode === "sign-up" ? <>Already have an account? <button type="button" onClick={() => navigateMode("sign-in")}>Sign in</button></>
                      : <button type="button" onClick={() => navigateMode("sign-in")}>Back to sign in</button>}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </section>

      <aside className="auth-art-panel" aria-hidden="true"><ThreadLightCanvas className="auth-art-canvas" /></aside>
    </main>
  );
}
