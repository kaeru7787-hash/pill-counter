import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";
test.use({ serviceWorkers: "block" });
// Native touch pointers use this same handler. Synthetic ids cannot capture.
async function gesture(page: Page, kind: "expand" | "shrink" | "pan" | "cancel") {
  await page.locator("#canvas-wrap").scrollIntoViewIfNeeded();
  await page.evaluate((kind) => {
    const v = document.querySelector<HTMLElement>("#canvas-wrap")!;
    const r = v.getBoundingClientRect(), cx = r.x+r.width/2, cy = r.y+r.height/2;
    const capture = v.setPointerCapture; v.setPointerCapture = () => {};
    const emit = (type: string, id: number, x: number) => v.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: "touch", clientX: cx+x, clientY: cy, bubbles: true,
    }));
    if (kind === "pan" || kind === "cancel") {
      emit("pointerdown", 20, 0); emit("pointermove", 20, 45);
      emit(kind === "cancel" ? "pointercancel" : "pointerup", 20, 45);
    } else {
      const from = kind === "expand" ? 30 : 60, to = kind === "expand" ? 60 : 30;
      emit("pointerdown", 20, -from); emit("pointerdown", 21, from);
      emit("pointermove", 20, -to); emit("pointermove", 21, to);
      emit("pointerup", 20, -to); emit("pointerup", 21, to);
    }
    v.setPointerCapture = capture;
  }, kind);
}
async function zoom(page: Page, value: number) {
  await page.locator("#zoom").evaluate((el, value) => {
    (el as HTMLInputElement).value=String(value); el.dispatchEvent(new Event("input", {bubbles:true}));
  }, value);
}
test("integrated pinch only in select, editing coordinates, export and reset", async ({page,context}, info) => {
  const errors: string[]=[]; page.on("pageerror", e=>errors.push(e.message));
  await context.route("**/models/config.json", r=>r.fulfill({status:404,body:""}));
  await page.goto("./?debug=1");
  await expect(page.locator("#open-result-zoom, [data-mode=roi], [data-mode=batch], #reset-roi")).toHaveCount(0);
  await page.locator("#file").setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#count")).toHaveText("24");
  await gesture(page,"expand"); await expect(page.locator("#zoom-value")).toHaveText("200%");
  await gesture(page,"shrink"); await expect(page.locator("#zoom-value")).toHaveText("100%");
  await zoom(page,3);
  await gesture(page,"pan");
  const transform = await page.locator("#image-canvas").evaluate(el=>el.style.transform);
  expect(transform).toContain("45px");
  for (const mode of ["add","delete"]) {
    await page.locator(`[data-mode=${mode}]`).click();
    await gesture(page,"expand"); await gesture(page,"pan"); await gesture(page,"cancel");
    await expect(page.locator("#zoom-value")).toHaveText("300%");
    await expect(page.locator("#count")).toHaveText("24");
    expect(await page.locator("#image-canvas").evaluate(el=>el.style.transform)).toBe(transform);
  }
  await page.locator('[data-mode=add]').click();
  await page.locator("#canvas-wrap").scrollIntoViewIfNeeded();
  const expected = await page.locator("#canvas-wrap").evaluate(v=> {
    const r=v.getBoundingClientRect(), c=v.querySelector("canvas")!, cr=c.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2, imageX:(r.x+r.width/2-cr.x)*c.width/cr.width,imageY:(r.y+r.height/2-cr.y)*c.height/cr.height};
  });
  await page.mouse.click(expected.x,expected.y);
  await expect(page.locator("#count")).toHaveText("25");
  await page.locator("#save").click();
  await expect(page.locator("#status")).toContainText("この端末に保存");
  const downloadPromise=page.waitForEvent("download"); await page.locator("#export").click();
  const stream=await (await downloadPromise).createReadStream(); let data="";
  for await(const part of stream!) data+=part.toString();
  const record=JSON.parse(data).records[0];
  const manual=record.corrected.find((d:any)=>d.source==="manual");
  expect(manual.center.x).toBeCloseTo(expected.imageX,0);
  expect(manual.center.y).toBeCloseTo(expected.imageY,0);
  // Force download on both engines rather than native sharing / picker.
  await page.evaluate(()=>{
    Object.defineProperty(navigator,"canShare",{value:()=>false,configurable:true});
    Object.defineProperty(window,"showSaveFilePicker",{value:undefined,configurable:true});
  });
  const pngPromise=page.waitForEvent("download"); await page.locator("#save-result-image").click();
  const png=await pngPromise; const pngStream=await png.createReadStream();const chunks: Buffer[]=[];
  for await(const part of pngStream!) chunks.push(Buffer.from(part));
  const meta=await sharp(Buffer.concat(chunks)).metadata();
  expect([meta.width,meta.height]).toEqual([640,480]); expect(png.suggestedFilename()).toContain("_25.png");
  await page.locator("#undo").click(); await expect(page.locator("#count")).toHaveText("24");
  await page.locator("#redo").click(); await expect(page.locator("#count")).toHaveText("25");
  expect(await page.locator("#image-canvas").evaluate(el=>el.style.transform)).toBe(transform);
  await page.locator('[data-mode=select]').click();
  await page.locator("#canvas-wrap").scrollIntoViewIfNeeded();
  let box=(await page.locator("#canvas-wrap").boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect(page.locator("#delete-selected")).toBeEnabled();
  await page.locator('[data-mode=delete]').click();
  await page.locator("#canvas-wrap").scrollIntoViewIfNeeded();
  box=(await page.locator("#canvas-wrap").boundingBox())!;
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect(page.locator("#count")).toHaveText("24");
  await page.locator("#undo").click(); await expect(page.locator("#count")).toHaveText("25");
  await page.locator("#fit-image").click(); await expect(page.locator("#zoom-value")).toHaveText("100%");
  await zoom(page,2);
  page.on("dialog",d=>d.accept());
  await page.locator("#file").setInputFiles("tests/images/01-white-separated.png");
  await expect(page.locator("#status")).toContainText("解析完了");
  await expect(page.locator("#zoom-value")).toHaveText("100%"); await expect(page.locator("#count")).toHaveText("24");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.locator("#canvas-wrap").scrollIntoViewIfNeeded();
  await page.screenshot({path:`tests/reports/integrated-zoom-${info.project.name}.png`,fullPage:true});
  expect(errors).toEqual([]);
});
