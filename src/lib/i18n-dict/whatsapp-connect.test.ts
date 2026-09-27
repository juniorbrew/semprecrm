import { describe, expect, it } from "vitest";
import { translateLiteral } from "@/lib/i18n";

// wacrm #505 / #535 — the static English copy added for the Meta
// connection diagnostics and the failed-message line must all have a
// pt-BR entry (the DOM translator matches by exact string).
const KEYS = [
  "Last save failed",
  "Step",
  "Meta error code",
  "Trace ID",
  "Meta said",
  "Quote these details when contacting Meta support.",
  "Reading the phone number",
  "Listing the WABA phone numbers",
  "Registering the phone number",
  "Subscribing the WABA to the app",
  "Reading the WABA subscriptions",
  "Phone Number ID must contain only digits. Copy the numeric id from Meta → WhatsApp → API Setup, not the phone number itself.",
  "WhatsApp Business Account ID must contain only digits. Copy it from Meta → WhatsApp → API Setup.",
  "The WhatsApp Business Account is subscribed to this app — inbound webhooks can be delivered.",
  "The WhatsApp Business Account is not subscribed to this app, so Meta will not deliver inbound webhooks. Re-enter the access token and save again to subscribe it.",
  "Phone Number ID must contain only digits — it is the numeric id shown under Meta → WhatsApp → API Setup, not the phone number itself.",
  "WhatsApp Business Account ID must contain only digits — copy it from Meta → WhatsApp → API Setup.",
  "Not delivered",
  "The WhatsApp Business Account is subscribed to a different Meta app, not this one, so inbound webhooks go to that app. Save again with an access token from this app to subscribe it.",
  "Saved, but with a warning",
];

describe("pt-BR dictionary — WhatsApp connection diagnostics", () => {
  it.each(KEYS)("translates %s", (key) => {
    expect(translateLiteral(key, "pt-BR")).not.toBe(key);
  });
});
