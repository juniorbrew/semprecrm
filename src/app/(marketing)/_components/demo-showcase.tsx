const PIPELINE_STAGES = [
  {
    name: "Novo",
    deals: [
      { name: "Barbearia Vintage", value: "R$ 480" },
      { name: "Studio Fit", value: "R$ 1.200" },
    ],
  },
  {
    name: "Contato feito",
    deals: [{ name: "Doce & Cia Confeitaria", value: "R$ 690" }],
  },
  {
    name: "Proposta",
    deals: [{ name: "Loja da Ana", value: "R$ 2.150" }],
  },
  {
    name: "Fechado",
    deals: [{ name: "Ótica Bela Vista", value: "R$ 3.400" }],
  },
] as const;

export function DemoShowcase() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">Veja como fica na prática</h2>
        <p className="mt-3 text-muted-foreground">Painel, funil e caixa de entrada em um só sistema.</p>
      </div>
      <div className="mt-12 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-primary/10">
        <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-3">
          <span aria-hidden="true" className="size-2.5 rounded-full bg-destructive/60" />
          <span aria-hidden="true" className="size-2.5 rounded-full bg-amber-500/60" />
          <span aria-hidden="true" className="size-2.5 rounded-full bg-emerald-500/60" />
          <span translate="no" className="ml-3 text-xs text-muted-foreground">www.semprecrm.com.br/dashboard</span>
        </div>
        <div className="grid gap-4 p-6 sm:grid-cols-3">
          <dl className="rounded-xl bg-muted p-4">
            <dt className="text-xs text-muted-foreground">Conversas hoje</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums text-foreground">142</dd>
          </dl>
          <dl className="rounded-xl bg-muted p-4">
            <dt className="text-xs text-muted-foreground">Negócios em aberto</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums text-foreground">37</dd>
          </dl>
          <dl className="rounded-xl bg-muted p-4">
            <dt className="text-xs text-muted-foreground">Tempo médio de resposta</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums text-foreground">4&nbsp;min</dd>
          </dl>
          <div className="col-span-full space-y-2 rounded-xl bg-muted p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-xs text-muted-foreground">Funil de vendas</h3>
              <p className="text-xs tabular-nums text-muted-foreground">37 negócios abertos · mostrando 5</p>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PIPELINE_STAGES.map((stage) => (
                <div key={stage.name} className="space-y-2 rounded-lg bg-background p-2.5">
                  <p className="px-0.5 text-xs font-medium text-muted-foreground">{stage.name}</p>
                  {stage.deals.map((deal) => (
                    <div key={deal.name} className="rounded-md border border-border bg-card p-2">
                      <p className="truncate text-xs font-medium text-foreground">{deal.name}</p>
                      <p className="text-xs tabular-nums text-muted-foreground">{deal.value}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
