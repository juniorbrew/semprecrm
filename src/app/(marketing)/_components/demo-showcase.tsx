const PIPELINE_STAGES = ["Novo", "Contato feito", "Proposta", "Fechado"] as const;

export function DemoShowcase() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">Veja como fica na prática</h2>
        <p className="mt-3 text-muted-foreground">Painel, funil e caixa de entrada em um só sistema.</p>
      </div>
      <div className="mt-12 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-primary/10">
        <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-3">
          <span className="size-2.5 rounded-full bg-destructive/60" />
          <span className="size-2.5 rounded-full bg-amber-500/60" />
          <span className="size-2.5 rounded-full bg-emerald-500/60" />
          <span className="ml-3 text-xs text-muted-foreground">www.semprecrm.com.br/dashboard</span>
        </div>
        <div className="grid gap-4 p-6 sm:grid-cols-3">
          <div className="rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Conversas hoje</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">142</p>
          </div>
          <div className="rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Negócios em aberto</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">37</p>
          </div>
          <div className="rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Tempo médio de resposta</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">4 min</p>
          </div>
          <div className="col-span-full space-y-2 rounded-xl bg-muted p-4">
            <p className="text-xs text-muted-foreground">Funil de vendas</p>
            <div className="mt-2 flex gap-2">
              {PIPELINE_STAGES.map((stage) => (
                <div key={stage} className="flex-1 rounded-lg bg-background p-3 text-center">
                  <p className="text-xs text-muted-foreground">{stage}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
