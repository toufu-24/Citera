import { expect, test } from "@playwright/test";

function createMinimalPdf(): Buffer {
  const pageCount = 8;
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const fontObject = firstContentObject + pageCount;
  const objects = ["1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"];
  const pageReferences = Array.from(
    { length: pageCount },
    (_, index) => `${firstPageObject + index} 0 R`,
  ).join(" ");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageReferences}] /Count ${pageCount} >>\nendobj\n`,
  );
  for (let index = 0; index < pageCount; index += 1) {
    objects.push(
      `${firstPageObject + index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>\nendobj\n`,
    );
  }
  for (let index = 0; index < pageCount; index += 1) {
    const stream = `BT /F1 18 Tf 72 720 Td (Citera integration PDF page ${index + 1}) Tj ET\n`;
    objects.push(
      `${firstContentObject + index} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    );
  }
  objects.push(
    `${fontObject} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  );
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
  await page.getByRole("link", { name: "アカウント設定を開く" }).click();
  await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "ライブラリ" })).toBeVisible();

  await page.getByRole("button", { name: "論文を追加" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "DOIがない場合は手入力" }).click();
  await dialog.getByLabel("タイトル").fill(title);
  await dialog.getByLabel("著者").fill("Ada Lovelace, Alan Turing");
  await dialog.getByLabel("出版年").fill("2026");
  await dialog.getByLabel("掲載誌・会議").fill("Citera Research Notes");
  await dialog.getByRole("button", { name: "ライブラリへ保存" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible();

  await page.getByRole("link", { name: title }).click();
  await expect(page.locator(".detail-breadcrumb strong")).toHaveText(title);
  await expect(page.locator(".paper-identity select option")).toHaveText([
    "未着手",
    "読書中",
    "読了",
  ]);
  await page.locator('.pdf-upload input[type="file"]').setInputFiles({
    name: "citera-e2e.pdf",
    mimeType: "application/pdf",
    buffer: createMinimalPdf(),
  });
  await page.getByRole("button", { name: "PDFを見る" }).click();
  await expect(page.locator(".pdf-stage canvas").first()).toBeVisible({ timeout: 20_000 });

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const canvasBox = await page.locator(".pdf-stage canvas").first().boundingBox();
        return canvasBox ? canvasBox.width / canvasBox.height : 0;
      })
      .toBeCloseTo(612 / 792, 3);
    await expect
      .poll(() =>
        page.locator(".pdf-stage").evaluate((stage) => stage.scrollWidth <= stage.clientWidth + 1),
      )
      .toBeTruthy();
    expect(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth)).toBeTruthy();
  }

  await expect(page.locator(".pdf-page-shell")).toHaveCount(8);
  await expect(page.locator(".pdf-stage canvas")).toHaveCount(4);
  const pageNumberInput = page.getByLabel("ページ番号");
  await pageNumberInput.fill("8");
  await pageNumberInput.press("Enter");
  await expect(page.getByRole("img", { name: `${title}、8 ページ目` })).toBeVisible();
  await expect(page.locator(".pdf-stage canvas")).toHaveCount(4);

  await page.getByRole("button", { name: "論文情報に戻る" }).click();
  await expect(page.getByRole("heading", { name: "Abstract", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "目次" })).toHaveCount(0);
  const commentSection = page.locator("#paper-comment");
  await commentSection
    .getByPlaceholder("この論文について気づいたこと、研究との関係など…")
    .fill("**重要:** 再現実験を行う。\n\n- dataset を確認");
  await commentSection.getByRole("button", { name: "保存" }).click();
  const summarySection = page.locator(".summary-section");
  await summarySection.getByLabel("一言要約").fill("再現実験の設計と評価方法を確認する論文");
  await summarySection.getByRole("button", { name: "保存" }).click();

  await page.getByRole("button", { name: "論文詳細を閉じる" }).last().click();
  await page.getByRole("link", { name: "ライブラリ" }).first().click();
  await page.getByLabel("論文を検索").fill(title);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: title })).toContainText(
    "再現実験の設計と評価方法を確認する論文",
  );

  const row = page.getByRole("row").filter({ hasText: title });
  const fourStarButton = row.getByRole("button", { name: `${title}を4つ星に評価` });
  await fourStarButton.click();
  await expect(fourStarButton.locator("svg")).toHaveAttribute("fill", "currentColor");

  await row.getByRole("button", { name: `${title} のその他の操作` }).click();
  await expect(page.getByRole("menuitem", { name: "詳細を開く" })).toBeVisible();
  await page.keyboard.press("Escape");

  await row.getByRole("checkbox").check();
  const exportResponse = page.waitForResponse(
    (response) => response.url().includes("/v1/exports") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "BibTeX" }).click();
  await expect((await exportResponse).ok()).toBeTruthy();
});
