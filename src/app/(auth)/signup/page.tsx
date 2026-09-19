"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, CheckCircle, ChevronDown, UsersRound } from "lucide-react";
import {
  FieldError,
  PersonTypeToggle,
  RegistrationFields,
  registrationErrorMessage,
  type RegistrationFieldValues,
} from "@/components/account/registration-fields";
import {
  AddressFields,
  ContactFields,
  EMPTY_CONTACT,
  type ContactFormValues,
} from "@/components/account/contact-fields";
import { useLanguage } from "@/hooks/use-language";
import {
  validateAccountRegistration,
  type PersonType,
  type RegistrationErrors,
} from "@/lib/br/documents";
import { validateAccountContact, type ContactErrors } from "@/lib/br/lookup";
import { friendlyAuthError } from "../_lib/auth-errors";

const subscribeNoop = () => () => {};

const INPUT_CLASS =
  "border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20";

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // points back at /join/<token> so the user lands on the redeem
  // step after verifying instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");
  const { t } = useLanguage();

  // Pessoa física (CPF) or pessoa jurídica (CNPJ). The trigger stores
  // it on the new account so every member's data stays scoped to that
  // company. Invitees join an existing account, so they skip this.
  const [personType, setPersonType] = useState<PersonType>("pf");
  const [registration, setRegistration] = useState<RegistrationFieldValues>({
    taxId: "",
    legalName: "",
    tradeName: "",
  });
  const [fieldErrors, setFieldErrors] = useState<RegistrationErrors>({});
  // Phone, e-mail and address — optional, auto-filled from the CNPJ
  // for companies and from the CEP for everyone.
  const [contact, setContact] = useState<ContactFormValues>(EMPTY_CONTACT);
  const [contactErrors, setContactErrors] = useState<ContactErrors>({});
  const [contactOpen, setContactOpen] = useState(false);
  // The contact block is mounted after hydration: it is optional and
  // collapsed by default, and keeping it out of the server-rendered
  // tree keeps the signup boundary hydrating instantly (the block's
  // inputs stalled the boundary's lazy hydration in the dev server).
  const contactReady = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // English dictionary key — rendered through `t()`.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setContactErrors({});

    // Registration is validated before the password so the user sees
    // every problem on the form at once, not one per submit.
    const reg = inviteToken
      ? null
      : validateAccountRegistration({
          personType,
          taxId: registration.taxId,
          legalName: registration.legalName,
          tradeName: registration.tradeName,
          fullName,
        });
    const con = inviteToken ? null : validateAccountContact(contact);
    if ((reg && !reg.ok) || (con && !con.ok)) {
      if (reg && !reg.ok) setFieldErrors(reg.errors);
      if (con && !con.ok) {
        setContactErrors(con.errors);
        setContactOpen(true);
      }
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    // If we have an invite token, point Supabase's verification
    // email back at the join page so the user can accept after
    // verifying. Without a token, Supabase uses its default
    // redirect (the app root).
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/join/${encodeURIComponent(inviteToken)}`
      : undefined;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          // Read by handle_new_user (migration 042). Absent for invitees.
          ...(reg?.ok
            ? {
                person_type: reg.value.personType,
                tax_id: reg.value.taxId,
                legal_name: reg.value.legalName,
                account_name: reg.value.accountName,
              }
            : {}),
          // Read by handle_new_user (migration 043). Only set keys are sent.
          ...(con?.ok
            ? {
                ...(con.value.phone ? { phone: con.value.phone } : {}),
                ...(con.value.email ? { email: con.value.email } : {}),
                ...(con.value.address ? { address: con.value.address } : {}),
              }
            : {}),
        },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });

    if (error) {
      console.error("[signup] sign-up failed:", error.message);
      setError(friendlyAuthError(error));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              {t("Check your email")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("We sent a confirmation link to")}{" "}
              <span className="text-foreground">{email}</span>
              {t(". Check your inbox and click the link to confirm your account.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
            >
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("Back to sign in")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className={cn("w-full border-border bg-card", inviteToken ? "max-w-md" : "max-w-lg")}>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t("Create account & join") : t("Create account")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t("Confirm your e-mail and accept the invite to join the team.")
              : t("Get started with the WhatsApp CRM")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {t(error)}
              </div>
            )}

            {!inviteToken ? (
              <PersonTypeToggle
                value={personType}
                onChange={(next) => {
                  setPersonType(next);
                  setRegistration({ taxId: "", legalName: "", tradeName: "" });
                  setContact(EMPTY_CONTACT);
                  setFieldErrors({});
                  setContactErrors({});
                }}
                disabled={loading}
              />
            ) : null}

            {!inviteToken ? (
              <RegistrationFields
                personType={personType}
                values={registration}
                errors={fieldErrors}
                onChange={(patch) => setRegistration((prev) => ({ ...prev, ...patch }))}
                onCompany={(company) => {
                  // A new CNPJ is a new company: its contact block replaces
                  // whatever was there, even with blanks.
                  setContact({ phone: company.phone, email: company.email, address: company.address });
                  // Show what was filled in so the user can check it.
                  if (company.address.cep || company.phone || company.email) setContactOpen(true);
                }}
                disabled={loading}
                inputClassName={INPUT_CLASS}
              />
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                {!inviteToken && personType === "pj"
                  ? t("Person in charge")
                  : t("Full name")}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t("John Doe")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                aria-invalid={!!fieldErrors.fullName}
                className={INPUT_CLASS}
              />
              <FieldError
                message={
                  fieldErrors.fullName
                    ? t(registrationErrorMessage("fullName", fieldErrors.fullName, personType))
                    : null
                }
              />
            </div>

            {!inviteToken && contactReady ? (
              <div className="rounded-lg border border-border bg-muted/30">
                <button
                  type="button"
                  id="contact-section-toggle"
                  aria-expanded={contactOpen}
                  aria-controls="contact-section"
                  onClick={() => setContactOpen((open) => !open)}
                  className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-medium text-foreground"
                >
                  <span>
                    {personType === "pj" ? t("Company contact and address") : t("Contact and address")}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">{t("optional")}</span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 text-muted-foreground transition-transform",
                      contactOpen && "rotate-180",
                    )}
                  />
                </button>
                <div
                  id="contact-section"
                  hidden={!contactOpen}
                  className="flex flex-col gap-4 border-t border-border px-4 py-4"
                >
                  <ContactFields
                    values={contact}
                    errors={contactErrors}
                    onChange={(patch) => setContact((prev) => ({ ...prev, ...patch }))}
                    disabled={loading}
                    inputClassName={INPUT_CLASS}
                    emailLabel={personType === "pj" ? "Company e-mail" : "Contact e-mail"}
                  />
                  <AddressFields
                    address={contact.address}
                    errors={contactErrors}
                    onChange={(address) => setContact((prev) => ({ ...prev, address }))}
                    disabled={loading}
                    inputClassName={INPUT_CLASS}
                  />
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t("Email")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("you@example.com")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("Password")}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t("At least 6 characters")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                {t("Confirm password")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t("Repeat your password")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className={INPUT_CLASS}
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("Creating account...") : t("Create account")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("Already have an account?")}{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              {t("Sign in")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
