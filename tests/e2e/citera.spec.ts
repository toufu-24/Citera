import { expect, test } from "@playwright/test";

function createMinimalPdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 58 >>\nstream\nBT /F1 18 Tf 72 720 Td (Citera integration PDF) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

test("owner can add, upload, read, annotate, search, and export a paper", async ({ page }) => {
  const title = `Citera E2E ${Date.now()}`;

  await page.goto("/login");
  await page.getByRole("button", { name: "ローカル開発用アカウントで続ける" }).click();
  await expect(page.getByRole("heading", { name: "ライブラリ" })).toBeVisible();

  await page.getByRole("button", { name: "論文を追加" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("タイトル *").fill(title);
  await dialog.getByLabel("著者").fill("Ada Lovelace, Alan Turing");
  await dialog.getByLabel("出版年").fill("2026");
  await dialog.getByLabel("掲載誌・会議").fill("Citera Research Notes");
  await dialog.getByRole("button", { name: "ライブラリへ保存" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.getByRole("link", { name: title }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.locator('.pdf-upload input[type="file"]').setInputFiles({
    name: "citera-e2e.pdf",
    mimeType: "application/pdf",
    buffer: createMinimalPdf(),
  });
  await expect(page.locator(".pdf-stage canvas")).toBeVisible({ timeout: 20_000 });

  await page
    .getByPlaceholder("この論文についてメモを残す…")
    .fill("**重要:** 再現実験を行う。\n\n- dataset を確認");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".markdown-body")).toContainText("再現実験を行う");

  await page.getByRole("link", { name: "ライブラリ" }).first().click();
  await page.getByLabel("論文を検索").fill(title);
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: title });
  await row.getByRole("checkbox").check();
  const exportResponse = page.waitForResponse(
    (response) => response.url().includes("/v1/exports") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "BibTeX" }).click();
  await expect((await exportResponse).ok()).toBeTruthy();
});
