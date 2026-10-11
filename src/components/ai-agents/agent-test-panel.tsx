"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/hooks/use-language";
import { AGENT_LIMITS } from "@/lib/ai/agents";
import { LAB_LIMITS, LAB_SCENARIOS } from "@/lib/ai/lab-scenarios";

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
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-sm font-medium text-foreground">
          {t("Message that WOULD be sent")}
        </p>
        <div className="space-y-1.5">
          {result.parts.map((p, i) => (
            <p
              key={i}
              className="w-fit max-w-[85%] whitespace-pre-line rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
              data-no-translate
            >
              {p}
            </p>
          ))}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-xs text-muted-foreground">{t(s.label)}</dt>
            <dd className="truncate text-sm font-medium tabular-nums text-foreground" data-no-translate>
              {s.value}
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1.5 text-sm font-medium text-foreground">
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

/** What a good answer does for the chosen lab scenario, and what this test does not exercise. */
function ScenarioCriteria({ scenarioId }: { scenarioId: string }) {
  const { t } = useLanguage();
  const scenario = LAB_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return null;
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="mb-2 text-sm font-medium text-foreground">{t("What a good answer does")}</p>
      <ul className="list-inside list-disc space-y-1 text-sm text-foreground">
        {scenario.expect.map((e) => (
          <li key={e}>{t(e)}</li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{t(LAB_LIMITS)}</p>
    </div>
  );
}

/** The Teste tab: a made-up customer message → what the agent would answer. */
export function AgentTestPanel({ agentId, canTest }: { agentId: string; canTest: boolean }) {
  const { t } = useLanguage();
  const [scenarioId, setScenarioId] = useState("");
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
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t("Test this agent")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("No message is sent over WhatsApp • uses credits from your AI provider")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-test-scenario">{t("Scenario")}</Label>
          <select
            id="agent-test-scenario"
            value={scenarioId}
            onChange={(e) => {
              setScenarioId(e.target.value);
              const scenario = LAB_SCENARIOS.find((s) => s.id === e.target.value);
              if (scenario) setMessage(scenario.message);
            }}
            className="h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-foreground"
          >
            <option value="">{t("My own message")}</option>
            {LAB_SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {t(s.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-test-customer">{t("Customer name (optional)")}</Label>
          <Input
            id="agent-test-customer"
            value={customer}
            maxLength={AGENT_LIMITS.testNameMaxChars}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-test-message">{t("Customer message")}</Label>
          <Textarea
            id="agent-test-message"
            value={message}
            rows={4}
            maxLength={AGENT_LIMITS.testMessageMaxChars}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("E.g.: Do you deliver on Sundays?")}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {t(error)}
          </p>
        ) : null}
        {canTest ? (
          <Button disabled={running} onClick={() => void run()}>
            {running ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("Run test")}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{t("Only admins can run tests.")}</p>
        )}
      </section>
      <section className="space-y-4 border-t border-border pt-6" aria-live="polite">
        <h2 className="text-base font-semibold text-foreground">{t("Result")}</h2>
        <ScenarioCriteria scenarioId={scenarioId} />
        {result ? (
          <AgentTestResultView result={result} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("Run a test to see the answer here.")}</p>
        )}
      </section>
    </div>
  );
}
