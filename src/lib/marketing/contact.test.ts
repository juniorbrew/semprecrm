import { describe, expect, it } from "vitest";
import { validateContactSubmission } from "./contact";

const BASE = {
  name: "Maria Silva",
  email: "maria@example.com",
  company: "Acme",
  message: "Quero saber mais sobre o plano Empresa.",
  website: "",
};

describe("validateContactSubmission", () => {
  it("accepts a well-formed submission", () => {
    const result = validateContactSubmission(BASE);
    expect(result).toEqual({
      ok: true,
      data: {
        name: "Maria Silva",
        email: "maria@example.com",
        company: "Acme",
        message: "Quero saber mais sobre o plano Empresa.",
      },
    });
  });

  it("treats a filled honeypot field as spam without validating the rest", () => {
    const result = validateContactSubmission({
      ...BASE,
      name: "",
      website: "http://spam.example",
    });
    expect(result).toEqual({ ok: false, error: "spam detected", isSpam: true });
  });

  it("rejects a missing name", () => {
    const result = validateContactSubmission({ ...BASE, name: "" });
    expect(result).toEqual({ ok: false, error: "Nome é obrigatório" });
  });

  it("rejects an invalid email", () => {
    const result = validateContactSubmission({ ...BASE, email: "not-an-email" });
    expect(result).toEqual({ ok: false, error: "Informe um e-mail válido" });
  });

  it("rejects a message over the length limit", () => {
    const result = validateContactSubmission({ ...BASE, message: "a".repeat(2001) });
    expect(result).toEqual({
      ok: false,
      error: "Mensagem deve ter no máximo 2000 caracteres",
    });
  });

  it("treats a blank company as null", () => {
    const result = validateContactSubmission({ ...BASE, company: "   " });
    expect(result).toMatchObject({ ok: true, data: { company: null } });
  });
});
