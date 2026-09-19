// Friendly names for the account timezone shown on calendar surfaces
// ("Horário de Brasília (America/Sao_Paulo)" instead of the bare IANA
// id). Covers the Brazilian zones plus the few neighbours the settings
// select offers; anything else shows as a de-underscored id.

import type { Language } from "@/lib/i18n";

const TIMEZONE_NAMES: Record<string, Record<Language, string>> = {
  "America/Sao_Paulo": { "pt-BR": "Horário de Brasília", "en-US": "Brasília time" },
  "America/Manaus": { "pt-BR": "Horário do Amazonas", "en-US": "Amazon time" },
  "America/Rio_Branco": { "pt-BR": "Horário do Acre", "en-US": "Acre time" },
  "America/Noronha": {
    "pt-BR": "Horário de Fernando de Noronha",
    "en-US": "Fernando de Noronha time",
  },
  "America/Belem": { "pt-BR": "Belém", "en-US": "Belém" },
  "America/Fortaleza": { "pt-BR": "Fortaleza", "en-US": "Fortaleza" },
  "America/Recife": { "pt-BR": "Recife", "en-US": "Recife" },
  "America/Bahia": { "pt-BR": "Salvador (Bahia)", "en-US": "Salvador (Bahia)" },
  "America/Cuiaba": { "pt-BR": "Cuiabá", "en-US": "Cuiabá" },
  "America/Campo_Grande": { "pt-BR": "Campo Grande", "en-US": "Campo Grande" },
  "America/Porto_Velho": { "pt-BR": "Porto Velho", "en-US": "Porto Velho" },
  "America/Boa_Vista": { "pt-BR": "Boa Vista", "en-US": "Boa Vista" },
  "America/Argentina/Buenos_Aires": { "pt-BR": "Buenos Aires", "en-US": "Buenos Aires" },
  "America/Montevideo": { "pt-BR": "Montevidéu", "en-US": "Montevideo" },
  "America/Santiago": { "pt-BR": "Santiago", "en-US": "Santiago" },
  "America/Bogota": { "pt-BR": "Bogotá", "en-US": "Bogotá" },
  "America/Lima": { "pt-BR": "Lima", "en-US": "Lima" },
  "America/Mexico_City": { "pt-BR": "Cidade do México", "en-US": "Mexico City" },
  "America/New_York": { "pt-BR": "Nova York", "en-US": "New York" },
  "America/Chicago": { "pt-BR": "Chicago", "en-US": "Chicago" },
  "America/Denver": { "pt-BR": "Denver", "en-US": "Denver" },
  "America/Los_Angeles": { "pt-BR": "Los Angeles", "en-US": "Los Angeles" },
  "Europe/Lisbon": { "pt-BR": "Lisboa", "en-US": "Lisbon" },
  "Europe/London": { "pt-BR": "Londres", "en-US": "London" },
  "Europe/Madrid": { "pt-BR": "Madri", "en-US": "Madrid" },
  "Europe/Paris": { "pt-BR": "Paris", "en-US": "Paris" },
  "Europe/Berlin": { "pt-BR": "Berlim", "en-US": "Berlin" },
  "Africa/Luanda": { "pt-BR": "Luanda", "en-US": "Luanda" },
  "Africa/Maputo": { "pt-BR": "Maputo", "en-US": "Maputo" },
  "Asia/Tokyo": { "pt-BR": "Tóquio", "en-US": "Tokyo" },
  "Australia/Sydney": { "pt-BR": "Sydney", "en-US": "Sydney" },
};

/** "Horário de Brasília (America/Sao_Paulo)", or a readable id for unknown zones. */
export function timezoneLabel(tz: string, language: Language): string {
  if (tz === "UTC") return "UTC";
  const name = TIMEZONE_NAMES[tz]?.[language];
  return name ? `${name} (${tz})` : tz.replace(/_/g, " ");
}
