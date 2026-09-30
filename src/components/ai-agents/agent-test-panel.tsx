"use client";

import { useState } from "react";
import { BookOpen, FlaskConical, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/hooks/use-language";
import { AGENT_LIMITS } from "@/lib/ai/agents";

/** Response of POST /api/ai/agents/:id/test. */
export interface AgentTestResult {
  text: string;
  parts: string[];
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  latency_ms: number;
  knowledge: { title: string }[];
}

export function AgentTestResultView({ result }: { result: AgentTestResult }) {
  const { t, language } = useLanguage();
  const num = new Intl.NumberFormat(language);
  const money = new Intl.NumberFormat(language, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
  const stats = [
    { label: "Tokens", value: `${num.format(result.input_tokens)} + ${num.format(result.output_tokens)}` },
    { label: "Cost", value: money.format(result.cost_cents / 100) },
    { label: "Latency", value: `${num.format(result.latency_ms)} ms` },
    { label: "Model", value: result.model },
  ];
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Message that WOULD be sent")}
        </p>
        <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
          {result.parts.map((p, i) => (
            <p
              key={i}
              className="ml-auto w-fit max-w-[85%] whitespace-pre-line rounded-lg rounded-tr-sm bg-primary-soft px-3 py-2 text-sm text-foreground"
              data-no-translate
            >
              {p}
            </p>
          ))}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{t(s.label)}</dt>
            <dd className="truncate text-sm font-medium tabular-nums text-foreground" data-no-translate>
              {s.value}
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <BookOpen className="size-3.5" />
          {t("Knowledge base used")}
        </p>
        {result.knowledge.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No knowledge-base snippet was used.")}</p>
        ) : (
          <ul className="list-inside list-disc text-sm text-foreground" data-no-translate>
            {result.knowledge.map((k, i) => (
              <li key={i}>{k.title}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The Teste tab: a made-up customer message → what the agent would answer. */
export function AgentTestPanel({ agentId, canTest }: { agentId: string; canTest: boolean }) {
  const { t } = useLanguage();
  const [message, setMessage] = useState("");
  const [customer, setCustomer] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentTestResult | null>(null);

  async function run() {
    if (!message.trim()) return setError("Type a customer message to test (up to 1000 characters).");
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/agents/${agentId}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, customer_name: customer }),
      });
      const body = (await res.json().catch(() => null)) as (AgentTestResult & { error?: string }) | null;
      if (!res.ok) {
        return setError(
          res.status === 429
            ? "Too many requests. Wait a minute and try again."
            : (body?.error ?? "Could not generate the suggestion. Try again."),
        );
      }
      setResult(body);
    } catch {
      setError("Could not generate the suggestion. Try again.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <FlaskConical className="size-4 text-primary" />
            {t("Test this agent")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("No message is sent over WhatsApp • uses credits from your AI provider")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-test-customer" className="text-foreground">
              {t("Customer name (optional)")}
            </Label>
            <Input
              id="agent-test-customer"
              value={customer}
              maxLength={AGENT_LIMITS.testNameMaxChars}
              onChange={(e) => setCustomer(e.target.value)}
              className="bg-card text-foreground"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-test-message" className="text-foreground">
              {t("Customer message")}
            </Label>
            <Textarea
              id="agent-test-message"
              value={message}
              rows={4}
              maxLength={AGENT_LIMITS.testMessageMaxChars}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("E.g.: Do you deliver on Sundays?")}
              className="bg-card text-foreground"
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {t(error)}
            </p>
          ) : null}
          {canTest ? (
            <Button disabled={running} onClick={() => void run()}>
              {running ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
              {t("Run test")}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t("Only admins can run tests.")}</p>
          )}
        </CardContent>
      </Card>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-foreground">{t("Result")}</CardTitle>
        </CardHeader>
        <CardContent>
          {result ? (
            <AgentTestResultView result={result} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("Run a test to see the answer here.")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
