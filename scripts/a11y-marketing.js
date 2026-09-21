// Accessibility audit of the marketing pages with axe-core (WCAG 2.1 A/AA +
// best-practice), in both color modes. Runs inside `playwright-cli run-code`,
// so this file is a single `async page => {}` function, not a module.
//
//   npm run a11y:marketing        # audits http://localhost:3101 (the Docker app)
//
// Against another origin (e.g. a local `next dev -p 3102`):
//   npx playwright cli open http://localhost:3102
//   npx playwright cli --raw run-code --filename=scripts/a11y-marketing.js
//   npx playwright cli close
//
// Exits non-zero (via a thrown error) when any page/mode has violations.

// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- run-code evaluates this bare function expression
async (page) => {
  const base = await page.evaluate(() => location.origin);
  const pages = ["/", "/contato", "/precos"];
  const modes = ["dark", "light"];
  const axePath = "node_modules/axe-core/axe.min.js";

  const rows = [];
  let failed = false;

  for (const mode of modes) {
    for (const path of pages) {
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.evaluate((m) => {
        document.documentElement.dataset.mode = m;
      }, mode);
      // Let `transition-colors` settle, otherwise axe samples mid-transition colors.
      await page.waitForTimeout(1000);
      await page.addScriptTag({ path: axePath });

      const result = await page.evaluate(async () => {
        const r = await window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
        });
        return {
          passes: r.passes.length,
          incomplete: r.incomplete.length,
          violations: r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.map((n) => {
              const el = document.querySelector(n.target[0]);
              const text = (el?.textContent ?? "").trim().slice(0, 40);
              const data = n.any[0]?.data ?? {};
              const ratio = data.contrastRatio ? ` (${data.contrastRatio}:1, need ${data.expectedContrastRatio})` : "";
              return `"${text}"${ratio} ← ${n.target[0]}`;
            }),
          })),
        };
      });

      const label = `${mode.padEnd(5)} ${path.padEnd(9)}`;
      if (result.violations.length === 0) {
        rows.push(`✓ ${label} passes=${result.passes} incomplete=${result.incomplete}`);
      } else {
        failed = true;
        rows.push(`✗ ${label} ${result.violations.length} rule(s) violated:`);
        for (const v of result.violations) {
          rows.push(`    ${v.id} [${v.impact}] — ${v.help}`);
          for (const node of v.nodes) rows.push(`      ${node}`);
        }
      }
    }
  }

  const report = rows.join("\n");
  if (failed) throw new Error("axe violations found:\n" + report);
  return report;
}
