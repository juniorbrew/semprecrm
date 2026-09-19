// ============================================================
// Validation for the public /contato form (POST
// /api/marketing/contact). Pure, no I/O — mirrors the manual-
// validation convention used across the app's API routes (no
// zod in this codebase).
// ============================================================

export const CONTACT_LIMITS = {
  name: 120,
  email: 160,
  company: 120,
  message: 2000,
} as const;

export interface ContactSubmissionInput {
  name: unknown;
  email: unknown;
  company: unknown;
  message: unknown;
  /** Honeypot field — must arrive empty from a real visitor. */
  website: unknown;
}

export interface ContactSubmissionData {
  name: string;
  email: string;
  company: string | null;
  message: string;
}

export type ContactValidationResult =
  | { ok: true; data: ContactSubmissionData }
  | { ok: false; error: string; isSpam?: boolean };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateContactSubmission(
  input: ContactSubmissionInput,
): ContactValidationResult {
  // Honeypot: a real visitor never sees or fills this hidden field.
  // A bot that fills every input does. Report success upstream
  // without writing anything, so the bot can't tell it was rejected.
  const website = typeof input.website === "string" ? input.website.trim() : "";
  if (website.length > 0) {
    return { ok: false, error: "spam detected", isSpam: true };
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required" };
  if (name.length > CONTACT_LIMITS.name) {
    return { ok: false, error: `Name must be ${CONTACT_LIMITS.name} characters or fewer` };
  }

  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email || email.length > CONTACT_LIMITS.email || !EMAIL_RE.test(email)) {
    return { ok: false, error: "A valid email is required" };
  }

  const companyRaw = typeof input.company === "string" ? input.company.trim() : "";
  if (companyRaw.length > CONTACT_LIMITS.company) {
    return { ok: false, error: `Company must be ${CONTACT_LIMITS.company} characters or fewer` };
  }
  const company = companyRaw.length > 0 ? companyRaw : null;

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) return { ok: false, error: "Message is required" };
  if (message.length > CONTACT_LIMITS.message) {
    return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer` };
  }

  return { ok: true, data: { name, email, company, message } };
}
