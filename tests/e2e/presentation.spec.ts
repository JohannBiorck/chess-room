import { writeFile } from "node:fs/promises";
import { gameViewSchema, type MoveInput } from "@chess-room/contracts";
import { type Browser, type BrowserContext, expect, type Page, type Route } from "@playwright/test";
import { test } from "./fixtures";

type Audit = {
  contexts: number;
  starts: string[];
  moves: string[];
  cats: string[];
  previewMs: number[];
};
type Players = { host: Page; friend: Page; contexts: BrowserContext[]; errors: string[] };

test.beforeAll(async () => {
  test.setTimeout(95_000);
  // Other suites share the genuine per-IP guest-session guard. These two flows
  // use four fresh guests after its window, without altering production limits.
  await new Promise((resolve) => setTimeout(resolve, 60_050));
});

async function audit(context: BrowserContext) {
  await context.addInitScript(() => {
    const log: Audit = { contexts: 0, starts: [], moves: [], cats: [], previewMs: [] };
    Reflect.set(window, "presentationAudit", log);
    let pendingPreview: { square: HTMLElement; previous: string; at: number } | null = null;
    document.addEventListener(
      "click",
      (event) => {
        const square =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-square]")
            : null;
        const label = square?.getAttribute("aria-label") ?? "";
        if (square && label.includes("legal destination"))
          pendingPreview = {
            square,
            previous: label.replace(", legal destination", ""),
            at: performance.now(),
          };
      },
      true,
    );
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        log.contexts += 1;
      }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        source.start = (...args) => {
          log.starts.push("wood");
          start(...args);
        };
        return source;
      }
      createOscillator() {
        const source = super.createOscillator();
        const start = source.start.bind(source);
        source.start = (...args) => {
          log.starts.push("tone");
          start(...args);
        };
        return source;
      }
    };
    new MutationObserver((mutations) => {
      if (pendingPreview) {
        const label = pendingPreview.square.getAttribute("aria-label") ?? "";
        if (label.replace(", legal destination", "") !== pendingPreview.previous) {
          log.previewMs.push(performance.now() - pendingPreview.at);
          pendingPreview = null;
        }
      }
      for (const mutation of mutations)
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          for (const target of [
            node,
            ...node.querySelectorAll<HTMLElement>("[data-move-animation], [data-cat-ply]"),
          ]) {
            if (target.dataset.moveAnimation) log.moves.push(target.dataset.moveAnimation);
            if (target.dataset.catPly) log.cats.push(target.dataset.catPly);
          }
        }
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
  });
}
async function readAudit(page: Page): Promise<Audit> {
  return page.evaluate(() => Reflect.get(window, "presentationAudit"));
}
async function createPlayers(browser: Browser): Promise<Players> {
  const hostContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const friendContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await audit(hostContext);
  await audit(friendContext);
  const host = await hostContext.newPage();
  const friend = await friendContext.newPage();
  const errors: string[] = [];
  for (const page of [host, friend])
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error("Browser runtime error:", error.message);
    });
  await host.goto("/");
  await host.getByLabel("Your display name", { exact: true }).fill("Motion host");
  await host.getByLabel("Your pieces").selectOption("white");
  await host.getByRole("radio", { name: /Cat Chess/ }).check();
  for (const name of ["Your cat", "Friend’s cat"]) {
    const slider = host.getByRole("slider", { name, exact: true });
    await slider.focus();
    await host.keyboard.press("End");
  }
  await host.getByRole("button", { name: "Create private room", exact: true }).click();
  const invitation = await host.getByLabel("Private invitation link", { exact: true }).inputValue();
  await friend.goto(invitation);
  await friend.getByLabel("Your display name", { exact: true }).fill("Motion friend");
  await friend.getByRole("button", { name: "Join private room", exact: true }).click();
  for (const page of [host, friend])
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  return { host, friend, contexts: [hostContext, friendContext], errors };
}
async function game(page: Page) {
  const id = await page.evaluate(() => localStorage.getItem("chess-room.current-game"));
  const response = await page.request.get(`/api/games/${id}`);
  expect(response.ok()).toBe(true);
  return gameViewSchema.parse(await response.json());
}
async function move(page: Page, input: MoveInput) {
  await expect(page.locator(`[data-square="${input.from}"]`)).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await page.locator(`[data-square="${input.from}"]`).click();
  await expect(page.locator(`[data-square="${input.to}"]`)).toHaveAttribute(
    "aria-label",
    /legal destination/,
  );
  await page.locator(`[data-square="${input.to}"]`).click();
}
async function settings(page: Page) {
  const details = page.locator(".game-heading .presentation-settings");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
  return details;
}
async function enableSound(page: Page) {
  const panel = await settings(page);
  await panel.getByRole("button", { name: "Enable sound", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name: "Mute sound", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(panel.getByRole("button", { name: "Test sound", exact: true })).toBeEnabled();
  await panel.locator("summary").click();
}
async function finish(players: Players) {
  const current = await game(players.host);
  if (current.game.phase === "active") {
    await players.host.getByRole("button", { name: "Resign", exact: true }).click();
    await players.host.getByRole("button", { name: "Resign game", exact: true }).click();
    await expect(
      players.host.getByRole("heading", { name: "Motion friend wins", exact: true }),
    ).toBeVisible();
  }
  for (const context of players.contexts) await context.close();
}

test("both friends get one current move/cat cue, while retry, reload and rejected previews stay silent", async ({
  browser,
}, testInfo) => {
  const players = await createPlayers(browser);
  const { host, friend } = players;
  const pattern = /\/api\/games\/[^/]+\/commands$/;
  let attempts = 0;
  const handler = async (route: Route) => {
    attempts += 1;
    if (attempts === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await expect.poll(async () => (await readAudit(host)).starts.length).toBe(2);
      await route.abort();
    } else await route.continue();
  };
  try {
    expect((await readAudit(host)).contexts).toBe(0);
    expect((await readAudit(friend)).contexts).toBe(0);
    await enableSound(host);
    await enableSound(friend);
    await host.route(pattern, handler);
    await move(host, { from: "e2", to: "e4" });
    await expect(host.getByRole("button", { name: "Retry command", exact: true })).toBeVisible();
    await expect.poll(async () => (await readAudit(friend)).starts.length).toBe(2);
    await host.getByRole("button", { name: "Retry command", exact: true }).click();
    await expect(host.getByRole("button", { name: "Retry command", exact: true })).toHaveCount(0);
    await host.unroute(pattern, handler);
    await expect(host.locator(".cat-layer")).toHaveCount(0);
    await expect(friend.locator(".cat-layer")).toHaveCount(0);
    for (const page of [host, friend]) {
      const log = await readAudit(page);
      expect(log.starts).toEqual(["wood", "tone"]);
      expect(log.moves).toHaveLength(1);
      expect(log.cats).toEqual(["1"]);
    }
    const panel = await settings(host);
    await panel.getByLabel("Animation preference").selectOption("reduced");
    const volume = panel.getByRole("slider", { name: /Effect volume/ });
    await volume.focus();
    await host.keyboard.press("Home");
    for (let step = 0; step < 58; step += 1) await host.keyboard.press("ArrowRight");
    await expect(volume).toHaveValue("58");
    await panel.locator("summary").click();
    await move(friend, { from: "e7", to: "e5" });
    await expect.poll(async () => (await readAudit(host)).starts.length).toBe(4);
    await expect.poll(async () => (await readAudit(friend)).starts.length).toBe(4);
    expect((await readAudit(host)).moves).toHaveLength(1);
    expect((await readAudit(host)).cats).toEqual(["1"]);
    await expect(host.locator(".cat-layer, .move-layer")).toHaveCount(0);
    await expect(friend.locator(".cat-layer")).toHaveCount(0);
    const before = await game(host);
    const legal = before.game.position.legalMoves.find((entry) => !entry.promotion);
    if (!legal) throw new Error("Expected a legal move.");
    const reject = async (route: Route) => {
      const command = route.request().postDataJSON();
      await route.continue({
        postData: JSON.stringify({ ...command, expectedRevision: command.expectedRevision - 1 }),
      });
    };
    await host.route(pattern, reject);
    await move(host, legal);
    await expect(host.getByRole("alert")).toContainText("The game changed");
    expect((await readAudit(host)).starts).toHaveLength(4);
    expect((await game(host)).game.position.board).toEqual(before.game.position.board);
    await host.unroute(pattern, reject);
    await host.getByRole("button", { name: "Dismiss error", exact: true }).click();
    const observations = {
      scenario:
        "Two accepted turns and one rejected optimistic preview; local browser observations, not a capacity benchmark",
      browser: await host.evaluate(() => navigator.userAgent),
      hostPreviewMs: (await readAudit(host)).previewMs,
      friendPreviewMs: (await readAudit(friend)).previewMs,
      hostAudioContexts: (await readAudit(host)).contexts,
      friendAudioContexts: (await readAudit(friend)).contexts,
    };
    const observationsPath = testInfo.outputPath("presentation-observations.json");
    await writeFile(observationsPath, JSON.stringify(observations, null, 2));
    await testInfo.attach("presentation-observations", {
      path: observationsPath,
      contentType: "application/json",
    });
    await host.reload();
    await expect(host.getByRole("heading", { name: "Your move", exact: true })).toBeVisible();
    expect(await readAudit(host)).toEqual({
      contexts: 0,
      starts: [],
      moves: [],
      cats: [],
      previewMs: [],
    });
    const saved = await settings(host);
    await expect(saved.getByRole("slider", { name: /Effect volume/ })).toHaveValue("58");
    await expect(saved.getByLabel("Animation preference")).toHaveValue("reduced");
    await expect(saved.getByRole("button", { name: "Enable sound", exact: true })).toBeVisible();
    await host.setViewportSize({ width: 390, height: 844 });
    const overflow = await host.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
    await host.screenshot({
      path: testInfo.outputPath("sound-and-motion-mobile.png"),
      fullPage: true,
    });
    await saved.locator("summary").click();
    expect(players.errors).toEqual([]);
  } finally {
    await host.unroute(pattern, handler);
    await finish(players);
  }
});

test("hidden turns stay silent without a backlog, then an enabled foreground turn works", async ({
  browser,
}) => {
  const players = await createPlayers(browser);
  const { host, friend } = players;
  try {
    await enableSound(host);
    await host.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await move(host, { from: "e2", to: "e4" });
    await expect(host.getByText("1 move", { exact: true })).toBeVisible();
    expect((await readAudit(host)).starts).toEqual([]);
    expect((await readAudit(friend)).contexts).toBe(0);
    expect((await readAudit(friend)).starts).toEqual([]);
    await host.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(host.locator(".cat-layer, .move-layer")).toHaveCount(0);
    const panel = await settings(host);
    if (await panel.getByRole("button", { name: "Enable sound", exact: true }).isVisible())
      await panel.getByRole("button", { name: "Enable sound", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Test sound", exact: true })).toBeEnabled();
    expect((await readAudit(host)).starts).toEqual([]);
    await panel.locator("summary").click();
    await move(friend, { from: "e7", to: "e5" });
    await expect.poll(async () => (await readAudit(host)).starts.length).toBe(2);
    expect((await readAudit(host)).cats).toEqual(["2"]);
    const muted = await settings(host);
    await muted.getByRole("button", { name: "Mute sound", exact: true }).click();
    await expect(muted.getByRole("button", { name: "Enable sound", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await muted.locator("summary").click();
    expect(players.errors).toEqual([]);
  } finally {
    await finish(players);
  }
});
