import { test, expect } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test("numbered image zoom, pan, pinch and close preserve corrections", async ({
  page,
  context,
}) => {
  await context.addInitScript(() =>
    localStorage.setItem("pill-ai-enabled", "false"),
  );
  await page.goto("./");
  await expect(page.locator("#open-result-zoom")).toBeDisabled();
  await page
    .locator("#file")
    .setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await page.locator('[data-mode="add"]').click();
  const source = page.locator("#image-canvas");
  const box = (await source.boundingBox())!;
  await source.click({
    position: { x: box.width * 0.88, y: box.height * 0.85 },
  });
  await expect(page.locator("#count")).toHaveText("25");
  const open = page.locator("#open-result-zoom"),
    dialog = page.getByRole("dialog");
  await open.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("canvas")).toHaveAttribute("width", "640");
  await expect(dialog.locator("output")).toHaveText("100%");
  await dialog.getByRole("button", { name: "拡大", exact: true }).click();
  await expect(dialog.locator("output")).toHaveText("150%");
  // Exercise the same two-pointer stream dispatched by mobile browsers.
  // Synthetic pointer ids cannot acquire native capture; suppress only capture.
  const pinch = async (expand: boolean) =>
    page.evaluate((expand) => {
      const v = document.querySelector<HTMLElement>(".result-zoom-viewport")!;
      const rect = v.getBoundingClientRect(),
        cx = rect.x + rect.width / 2,
        cy = rect.y + rect.height / 2;
      const capture = v.setPointerCapture;
      v.setPointerCapture = () => {};
      const emit = (type: string, id: number, x: number) =>
        v.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            clientX: cx + x,
            clientY: cy,
            bubbles: true,
          }),
        );
      const from = expand ? 40 : 80,
        to = expand ? 80 : 40;
      emit("pointerdown", 20, -from);
      emit("pointerdown", 21, from);
      emit("pointermove", 20, -to);
      emit("pointermove", 21, to);
      emit("pointerup", 20, -to);
      emit("pointerup", 21, to);
      v.setPointerCapture = capture;
    }, expand);
  await pinch(true);
  await expect(dialog.locator("output")).toHaveText("300%");
  await pinch(false);
  await expect(dialog.locator("output")).toHaveText("150%");
  await expect(page.locator("#count")).toHaveText("25");
  const viewport = await dialog.locator(".result-zoom-viewport").boundingBox();
  await page.mouse.move(
    viewport!.x + viewport!.width / 2,
    viewport!.y + viewport!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    viewport!.x + viewport!.width / 2 + 50,
    viewport!.y + viewport!.height / 2 + 50,
  );
  await page.mouse.up();
  await dialog.getByRole("button", { name: "拡大画像を閉じる" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  await page.locator("#undo").click();
  await expect(page.locator("#count")).toHaveText("24");
  await open.click();
  await expect(dialog.locator("output")).toHaveText("100%");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
