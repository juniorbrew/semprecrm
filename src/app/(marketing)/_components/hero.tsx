"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  CalendarClock,
  CheckCheck,
  CheckCircle2,
  Circle,
  Paperclip,
  Send,
  Smile,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

const FRAMES = [
  { key: "inbox", label: "Caixa de entrada" },
  { key: "pipeline", label: "Funil" },
  { key: "tasks", label: "Tarefas" },
  { key: "calendar", label: "Agenda" },
] as const;

type FrameKey = (typeof FRAMES)[number]["key"];

const ROTATE_MS = 4500;

function InboxFrame() {
  return (
    <>
      {/* CRM context bar — this is what turns a chat into a deal */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 bg-muted/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary-readable">
            AR
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">Ana Rocha</p>
            <p className="truncate text-xs text-muted-foreground">Loja da Ana · +55 11 9••••-4521</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary-readable">
          Proposta enviada
        </span>
      </div>
      {/* WhatsApp-style thread — a fixed "phone screen", independent of light/dark mode */}
      <div className="space-y-2.5 bg-[#0b141a] px-4 py-5">
        <div className="flex justify-start">
          <p className="max-w-[80%] rounded-lg rounded-tl-none bg-[#202c33] px-3 py-2 text-sm text-[#e9edef]">
            Oi! Vi os produtos no catálogo, ainda dá pra fechar no valor de hoje?
          </p>
        </div>
        <div className="flex justify-end">
          <p className="max-w-[80%] rounded-lg rounded-tr-none bg-[#005c4b] px-3 py-2 text-sm text-[#e9edef]">
            Dá sim! Te mando a proposta certinha agora 🙂
            <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[#c5d3d9]">
              09:41
              <CheckCheck aria-hidden="true" className="size-3.5 text-[#53bdeb]" strokeWidth={2.5} />
            </span>
          </p>
        </div>
        <div className="flex justify-end">
          <p className="max-w-[80%] rounded-lg rounded-tr-none bg-[#005c4b] px-3 py-2 text-sm text-[#e9edef]">
            proposta-ana-rocha.pdf
            <span className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[#c5d3d9]">
              09:42
              <CheckCheck aria-hidden="true" className="size-3.5 text-[#53bdeb]" strokeWidth={2.5} />
            </span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 bg-[#202c33] px-4 py-2.5 text-[#8696a0]">
        <Smile aria-hidden="true" className="size-4 shrink-0" />
        <Paperclip aria-hidden="true" className="size-4 shrink-0" />
        <span className="flex-1 truncate text-xs">Digite uma mensagem</span>
        <Send aria-hidden="true" className="size-4 shrink-0 text-[#00a884]" />
      </div>
    </>
  );
}

const PIPELINE_COLUMNS = [
  { name: "Novo", deal: "Barbearia Vintage", value: "R$ 480" },
  { name: "Contato feito", deal: "Doce & Cia Confeitaria", value: "R$ 690" },
  { name: "Proposta", deal: "Loja da Ana", value: "R$ 2.150" },
  { name: "Fechado", deal: "Ótica Bela Vista", value: "R$ 3.400" },
] as const;

function PipelineFrame() {
  return (
    <div className="grid h-[268px] grid-cols-2 content-center gap-2 bg-background px-4 sm:grid-cols-4">
      {PIPELINE_COLUMNS.map((column) => (
        <div key={column.name} className="space-y-2">
          <p className="px-0.5 text-xs font-medium text-muted-foreground">{column.name}</p>
          <div className="rounded-md border border-border bg-card p-2">
            <p className="truncate text-xs font-medium text-foreground">{column.deal}</p>
            <p className="text-xs text-muted-foreground">{column.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const TASKS = [
  { title: "Ligar para Ana Rocha — Loja da Ana", meta: "Hoje, 14:00", done: false, late: false },
  { title: "Enviar proposta — Studio Fit", meta: "Atrasada", done: false, late: true },
  { title: "Follow-up — Ótica Bela Vista", meta: "Concluída", done: true, late: false },
] as const;

function TasksFrame() {
  return (
    <div className="flex h-[268px] flex-col justify-center gap-2.5 bg-background px-4">
      {TASKS.map((task) => (
        <div key={task.title} className="flex items-start gap-3 rounded-lg bg-muted px-3 py-2.5">
          {task.done ? (
            <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          ) : (
            <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className={`truncate text-sm text-foreground ${task.done ? "line-through opacity-60" : ""}`}>
              {task.title}
            </p>
            <p className={`text-xs ${task.late ? "text-destructive" : "text-muted-foreground"}`}>{task.meta}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const EVENTS = [
  { time: "09:00", title: "Reunião — Barbearia Vintage" },
  { time: "14:30", title: "Demonstração — Doce & Cia Confeitaria" },
  { time: "16:00", title: "Follow-up — Studio Fit" },
] as const;

function CalendarFrame() {
  return (
    <div className="flex h-[268px] flex-col justify-center gap-2.5 bg-background px-4">
      <p className="px-0.5 text-xs font-medium text-muted-foreground">Hoje</p>
      {EVENTS.map((event) => (
        <div key={event.title} className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2.5">
          <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <p className="text-sm text-foreground">
            <span className="font-medium">{event.time}</span> · {event.title}
          </p>
        </div>
      ))}
    </div>
  );
}

export function Hero() {
  const [active, setActive] = useState<FrameKey>("inbox");
  const [paused, setPaused] = useState(false);
  const indexRef = useRef(0);

  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const id = setInterval(() => {
      indexRef.current = (indexRef.current + 1) % FRAMES.length;
      setActive(FRAMES[indexRef.current].key);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [paused]);

  function selectFrame(key: FrameKey) {
    indexRef.current = FRAMES.findIndex((frame) => frame.key === key);
    setActive(key);
  }

  // Roving tabindex: arrows/Home/End move between tabs and select on the fly
  // (WAI-ARIA tabs pattern), so keyboard users aren't limited to the active tab.
  function handleTabListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    if (event.key === "ArrowRight") next = (indexRef.current + 1) % FRAMES.length;
    else if (event.key === "ArrowLeft") next = (indexRef.current - 1 + FRAMES.length) % FRAMES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FRAMES.length - 1;
    else return;
    event.preventDefault();
    selectFrame(FRAMES[next].key);
    const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[next]?.focus();
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
        <div className="space-y-6">
          <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            CRM para WhatsApp
          </span>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            O WhatsApp da sua empresa, organizado em um só lugar
          </h1>
          <p className="text-lg text-muted-foreground">
            O SempreCRM reúne a caixa de entrada da sua equipe, o funil de vendas, as tarefas e a
            automação num único sistema — para pequenas e médias empresas que vendem e atendem
            pelo WhatsApp.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              data-analytics="cta_start_click"
              className={buttonVariants({ variant: "default", size: "lg", className: "px-6" })}
            >
              Começar grátis
            </Link>
            <Link
              href="/login"
              data-analytics="cta_login_click"
              className={buttonVariants({ variant: "outline", size: "lg", className: "px-6" })}
            >
              Entrar
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Teste grátis por 14 dias. Sem cartão de crédito.
          </p>
        </div>
        <div
          className="rounded-2xl border border-border bg-card p-2 shadow-2xl shadow-primary/10"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <div className="overflow-hidden rounded-xl border border-border">
            <div
              role="tablist"
              aria-label="Telas do sistema"
              onKeyDown={handleTabListKeyDown}
              className="flex gap-1 overflow-x-auto bg-muted/60 p-1.5"
            >
              {FRAMES.map((frame) => (
                <button
                  key={frame.key}
                  id={`hero-tab-${frame.key}`}
                  type="button"
                  role="tab"
                  aria-selected={active === frame.key}
                  aria-controls="hero-tabpanel"
                  tabIndex={active === frame.key ? 0 : -1}
                  onClick={() => selectFrame(frame.key)}
                  className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    active === frame.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {frame.label}
                </button>
              ))}
            </div>
            <div
              key={active}
              id="hero-tabpanel"
              role="tabpanel"
              aria-labelledby={`hero-tab-${active}`}
              className="min-h-[268px] animate-in fade-in duration-300 motion-reduce:animate-none"
            >
              {active === "inbox" && <InboxFrame />}
              {active === "pipeline" && <PipelineFrame />}
              {active === "tasks" && <TasksFrame />}
              {active === "calendar" && <CalendarFrame />}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
