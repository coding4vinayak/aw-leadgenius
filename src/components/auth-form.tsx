"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  redeemEmailVerification,
  redeemPasswordReset,
  requestPasswordReset,
  signIn,
  signUp,
  type AuthState,
  type RedeemState,
  type ResetState,
  type VerifyState,
} from "@/app/auth-actions";

/**
 * The login and signup form.
 *
 * Vanilla Tailwind greys rather than the design tokens abetConnect uses: this
 * is vendored into six apps whose globals.css do not define `--surface`,
 * `--line` or `--muted-dim`, and a form rendered in undeclared token classes
 * looks like it fell back to browser defaults. The product accent arrives as a
 * prop, the same way the shared dashboard shell takes it, so each product keeps
 * its own colour and the file stays byte-identical everywhere.
 */

const INITIAL: AuthState = {};

/** Accent class per product, keyed by the same prop the shell receives. */
const accentBg: Record<string, string> = {
  "text-emerald-600": "bg-emerald-600",
  "text-orange-600": "bg-orange-600",
  "text-purple-600": "bg-purple-600",
  "text-cyan-600": "bg-cyan-600",
  "text-violet-600": "bg-violet-600",
  "text-teal-600": "bg-teal-600",
};

/** Spread-safe view of a stored JSON object (config blobs, guardrail maps). */
const FIELD_CLASS =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-gray-500 focus:outline-none";

function SubmitButton({ label, accent }: { label: string; accent: string }) {
  // useFormStatus has to live inside the <form>, so the button is its own
  // component rather than inline markup.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`w-full rounded-md px-3 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 ${accentBg[accent] ?? "bg-gray-900"}`}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  placeholder,
  required,
  autoFocus,
  invalid,
  errorId,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  errorId?: string;
}) {
  const fieldId = `field-${name}`;
  return (
    <label htmlFor={fieldId} className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </span>
      <input
        id={fieldId}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        className={`${FIELD_CLASS} ${invalid ? "border-red-400" : ""}`}
      />
      {invalid && errorId && (
        <p id={errorId} className="mt-1 text-[11px] text-red-600" role="alert" aria-live="polite">
          {errorId}
        </p>
      )}
    </label>
  );
}

/**
 * mode "forgot" reuses this component for the reset request so the forms cannot
 * drift apart visually, but it is a different action with a different state
 * shape — a reset request must never claim an account does or does not exist.
 */
export function AuthForm({
  mode,
  accent,
  action,
}: {
  mode: "signup" | "login" | "forgot";
  accent: string;
  /** Overrides the default action; used by the reset request. */
  action?: (prev: ResetState, form: FormData) => Promise<ResetState>;
}) {
  const isSignup = mode === "signup";
  const isForgot = mode === "forgot";
  // The action returns validation errors instead of throwing, so the form can
  // render the message without a full page reload losing what was typed.
  const [authState, authAction] = useActionState(isSignup ? signUp : signIn, INITIAL);
  const [resetState, resetAction] = useActionState(
    action ?? requestPasswordReset,
    {} as ResetState,
  );
  const state = (isForgot ? resetState : authState) as AuthState & ResetState;
  const formAction = isForgot ? resetAction : authAction;

  // Generate unique error IDs for accessibility
  const nameErrorId = state.field === "name" && state.error ? "name-error" : undefined;
  const workspaceErrorId = state.field === "workspace" && state.error ? "workspace-error" : undefined;
  const emailErrorId = state.field === "email" && state.error ? "email-error" : undefined;
  const passwordErrorId = state.field === "password" && state.error ? "password-error" : undefined;

  if (isForgot && resetState.sent) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-3 text-[12px] leading-relaxed text-gray-800">
        <p>
          If that address has an account, a reset link is on its way. It works once and
          expires in an hour.
        </p>
        {resetState.channel === "log" && (
          <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900">
            This deployment has no mail provider configured, so nothing was actually
            sent — the link was written to the server log instead. Set
            <code className="mx-1 font-mono">RESEND_API_KEY</code> to deliver it.
          </p>
        )}
        <Link href="/login" className="mt-3 inline-block underline underline-offset-2">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3.5" noValidate>
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-relaxed text-gray-800"
        >
          {state.error}
        </p>
      )}

      {isSignup && (
        <>
          <Field
            label="Your name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Priya Raman"
            required
            autoFocus
            invalid={state.field === "name"}
            errorId={nameErrorId}
          />
          <Field
            label="Team or company"
            name="workspace"
            type="text"
            autoComplete="organization"
            placeholder="Northwind Logistics"
            invalid={state.field === "workspace"}
            errorId={workspaceErrorId}
          />
        </>
      )}

      <Field
        label={isForgot ? "Email" : "Work email"}
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        required
        autoFocus={!isSignup}
        invalid={state.field === "email"}
        errorId={emailErrorId}
      />
      {!isForgot && (
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          placeholder={isSignup ? "At least 8 characters" : "••••••••"}
          required
          invalid={state.field === "password"}
          errorId={passwordErrorId}
        />
      )}

      <SubmitButton
        label={isSignup ? "Create workspace" : isForgot ? "Send reset link" : "Sign in"}
        accent={accent}
      />

      {isForgot && (
        <p className="pt-1 text-center text-[12px] text-gray-500">
          <Link href="/login" className="text-gray-900 underline underline-offset-2">
            Back to sign in
          </Link>
        </p>
      )}

      {!isForgot && (
        <div className="pt-1 text-center text-[12px] text-gray-500">
          {!isSignup && (
            <p className="mb-2">
              <Link href="/forgot-password" className="text-gray-600 underline underline-offset-2">
                Forgot your password?
              </Link>
            </p>
          )}
          <p>
            {isSignup ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="text-gray-900 underline underline-offset-2">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                No account yet?{" "}
                <Link href="/signup" className="text-gray-900 underline underline-offset-2">
                  Create one
                </Link>
              </>
            )}
          </p>
        </div>
      )}
    </form>
  );
}

/**
 * Redeem an emailed token.
 *
 * Both of these are POST forms on purpose. A GET link would be swallowed by a
 * chat client's URL expander, a corporate scanner, or a link prefetcher, and the
 * token would be spent before the person ever saw the page — one preview in Slack
 * and their reset link is dead. The page shows the button; the click redeems.
 */
export function TokenRedeemForm({
  token,
  label,
  accent,
  action,
}: {
  token: string;
  label: string;
  accent: string;
  action: "verify" | "reset";
}) {
  const isVerify = action === "verify";
  const [verifyState, verifyAction] = useActionState(redeemEmailVerification, {} as VerifyState);
  const [redeemState, redeemAction] = useActionState(redeemPasswordReset, {} as RedeemState);
  const state = (isVerify ? verifyState : redeemState) as VerifyState & RedeemState;
  const formAction = isVerify ? verifyAction : redeemAction;

  // Generate unique error IDs for accessibility
  const passwordErrorId = state.error ? "password-error" : undefined;

  if (state.verified) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-3 text-[13px] leading-relaxed text-gray-800">
        <p>Your email address is confirmed. Your account is ready.</p>
        <Link href="/dashboard" className="mt-2 inline-block underline underline-offset-2">
          Go to your dashboard
        </Link>
      </div>
    );
  }

  if (state.done) {
    return (
      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-3 text-[13px] leading-relaxed text-gray-800">
        <p>Your password has been changed and every other session has been signed out.</p>
        <Link href="/login" className="mt-2 inline-block underline underline-offset-2">
          Sign in with it
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      {state.error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-relaxed text-gray-800">
          {state.error}
        </p>
      )}
      <input type="hidden" name="token" value={token} />
      {!isVerify && (
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          required
          autoFocus
          invalid={state.error !== undefined}
          errorId={passwordErrorId}
        />
      )}
      <SubmitButton label={label} accent={accent} />
    </form>
  );
}

/** Accent class per product, keyed by the same prop the shell receives. */
