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
type TurnObservation = {
  maxBoardDrift: number;
  maxScrollDrift: number;
  maxStatusHeightDrift: number;
  moveStarted: number | null;
  moveEnded: number | null;
  catStarted: number | null;
  catEnded: number | null;
  prematureGift: boolean;
  missingTheft: boolean;
};

async function observeTurn(page: Page) {
  await page.evaluate(async () => {
    const board = document.querySelector<HTMLElement>(".chessboard");
    if (!board) throw new Error("Expected a chess board.");
    const initial = board.getBoundingClientRect();
    window.scrollTo(
      0,
      initial.top + window.scrollY - Math.max(16, (innerHeight - initial.height) / 2),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const origin = board.getBoundingClientRect();
    const status = document.querySelector<HTMLElement>(".game-status");
    const statusHeight = status?.getBoundingClientRect().height ?? 0;
    const scroll = window.scrollY;
    const data: TurnObservation = {
      maxBoardDrift: 0,
      maxScrollDrift: 0,
      maxStatusHeightDrift: 0,
      moveStarted: null,
      moveEnded: null,
      catStarted: null,
      catEnded: null,
      prematureGift: false,
      missingTheft: false,
    };
    let frame = 0;
    const opacity = (element: Element | null) => {
      if (!element) return 0;
      const style = getComputedStyle(element);
      return style.visibility === "hidden" ? 0 : Number(style.opacity);
    };
    const sample = () => {
      const box = board.getBoundingClientRect();
      data.maxBoardDrift = Math.max(
        data.maxBoardDrift,
        Math.abs(box.top - origin.top),
        Math.abs(box.left - origin.left),
        Math.abs(box.width - origin.width),
        Math.abs(box.height - origin.height),
      );
      data.maxScrollDrift = Math.max(data.maxScrollDrift, Math.abs(window.scrollY - scroll));
      data.maxStatusHeightDrift = Math.max(
        data.maxStatusHeightDrift,
        Math.abs((status?.getBoundingClientRect().height ?? 0) - statusHeight),
      );
      const now = performance.now();
      const moving = document.querySelector(".move-layer");
      const cat = document.querySelector<HTMLElement>(".cat-target");
      if (moving && data.moveStarted === null) data.moveStarted = now;
      if (!moving && data.moveStarted !== null && data.moveEnded === null) data.moveEnded = now;
      if (cat && data.catStarted === null) data.catStarted = now;
      if (!cat && data.catStarted !== null && data.catEnded === null) data.catEnded = now;
      const stage = document.querySelector<HTMLElement>(".board-stage");
      const phase = stage?.dataset.catSequencePhase;
      const square = stage?.dataset.catSequenceSquare;
      if (square && (phase === "waiting" || phase === "arrive")) {
        const base = document.querySelector(`[data-square="${square}"] .board-piece`);
        const piece = cat?.querySelector(".cat-action-piece") ?? null;
        if (
          stage?.dataset.catSequenceAction === "add" &&
          Math.max(opacity(base), opacity(piece)) > 0.05
        )
          data.prematureGift = true;
        if (
          stage?.dataset.catSequenceAction === "remove" &&
          !moving &&
          Math.max(opacity(base), opacity(piece)) < 0.95
        )
          data.missingTheft = true;
      }
      frame = requestAnimationFrame(sample);
    };
    sample();
    Reflect.set(window, "turnObservation", { data, stop: () => cancelAnimationFrame(frame) });
  });
}

async function turnObservation(page: Page, stop = false): Promise<TurnObservation> {
  return page.evaluate((stop) => {
    const observation = Reflect.get(window, "turnObservation");
    if (stop) observation.stop();
    return observation.data;
  }, stop);
}

test.beforeAll(async () => {
  test.setTimeout(95_000);
  // Other suites share the genuine per-IP guest-session guard. Start these
  // flows after its full window without altering production limits.
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
async function createPlayers(
  browser: Browser,
  evil = false,
  hostName = "Motion host",
): Promise<Players> {
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
  await host.getByLabel("Your display name", { exact: true }).fill(hostName);
  await host.getByLabel("Your pieces").selectOption("white");
  await host.getByRole("radio", { name: /Cat Chess/ }).check();
  for (const name of ["Your cat", "Friend’s cat"]) {
    const slider = host.getByRole("slider", { name, exact: true });
    await slider.focus();
    await host.keyboard.press(evil ? "Home" : "End");
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

test("the viewport stays still and each piece finishes before its helpful or evil cat arrives", async ({
  browser,
}, testInfo) => {
  const path = testInfo.outputPath("turn-chronology-and-geometry.json");
  const observations: Array<{
    evil: boolean;
    player: string;
    turn: number;
    data: TurnObservation;
  }> = [];
  for (const evil of [false, true]) {
    const players = await createPlayers(browser, evil, "W".repeat(32));
    try {
      await players.friend.setViewportSize({ width: 320, height: 844 });
      await players.friend.evaluate(() => {
        const heading = document.querySelector<HTMLElement>(".status-heading-frame");
        if (heading) heading.style.fontSize = "40px";
        for (const paragraph of document.querySelectorAll<HTMLElement>(
          ".status-description-frame p",
        ))
          paragraph.style.fontSize = "18px";
      });
      for (const [index, actor, moveInput] of [
        [1, players.host, { from: "e2", to: "e4" }],
        [2, players.friend, { from: "e7", to: "e5" }],
      ] as const) {
        for (const page of [players.host, players.friend]) {
          await expect(page.locator(".move-layer, .cat-layer")).toHaveCount(0);
          await observeTurn(page);
        }
        await move(actor, moveInput);
        for (const [name, page] of [
          ["host", players.host],
          ["friend", players.friend],
        ] as const) {
          await expect.poll(async () => (await turnObservation(page)).catEnded).not.toBeNull();
          const data = await turnObservation(page, true);
          observations.push({ evil, player: name, turn: index, data });
          await writeFile(path, JSON.stringify(observations, null, 2));
          expect(data.maxBoardDrift).toBeLessThanOrEqual(1);
          expect(data.maxScrollDrift).toBeLessThanOrEqual(1);
          expect(data.maxStatusHeightDrift).toBeLessThanOrEqual(1);
          expect(data.moveStarted).not.toBeNull();
          expect(data.moveEnded).not.toBeNull();
          expect(data.catStarted).not.toBeNull();
          expect((data.moveEnded ?? 0) - (data.moveStarted ?? 0)).toBeGreaterThanOrEqual(300);
          expect((data.catStarted ?? 0) - (data.moveEnded ?? 0)).toBeGreaterThanOrEqual(40);
          expect((data.catEnded ?? 0) - (data.catStarted ?? 0)).toBeGreaterThanOrEqual(1800);
          expect(data.prematureGift).toBe(false);
          expect(data.missingTheft).toBe(false);
        }
        if (!evil && index === 1)
          await players.friend.screenshot({
            path: testInfo.outputPath("narrow-enlarged-status.png"),
            fullPage: true,
          });
      }
      expect(players.errors).toEqual([]);
    } finally {
      await finish(players);
    }
  }
  await writeFile(path, JSON.stringify(observations, null, 2));
  await testInfo.attach("turn-chronology-and-geometry", { path, contentType: "application/json" });
});

test("Cat Bot lets the live cat finish before moving, without shifting the board", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await audit(context);
  const page = await context.newPage();
  let observing = false;
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Play the cat", exact: true }).click();
    await page.getByLabel("Your display name", { exact: true }).fill("Patient cat player");
    await page.getByLabel("Your pieces", { exact: true }).selectOption("white");
    await page.getByLabel("Cat’s thinking", { exact: true }).selectOption("balanced");
    for (const name of ["Your cat", "Cat Bot’s cat"]) {
      await page.getByRole("slider", { name, exact: true }).focus();
      await page.keyboard.press("End");
    }
    await page.getByRole("button", { name: "Play the cat", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Your move", exact: true })).toBeVisible();
    await observeTurn(page);
    observing = true;
    await move(page, { from: "e2", to: "e4" });
    await expect(page.locator('[data-cat-ply="1"]')).toHaveAttribute("data-cat-phase", "paw");
    expect((await game(page)).game.position.moves).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("bot-cat-paw.png"), fullPage: true });
    await expect.poll(async () => (await turnObservation(page)).catEnded).not.toBeNull();
    expect((await turnObservation(page)).catEnded).not.toBeNull();
    await expect.poll(async () => (await game(page)).game.position.moves.length).toBe(2);
    await expect(page.locator('[data-cat-ply="2"]')).toBeVisible();
    await expect(page.locator(".cat-layer")).toHaveCount(0);
    const data = await turnObservation(page, true);
    expect(data.maxBoardDrift).toBeLessThanOrEqual(1);
    expect(data.maxScrollDrift).toBeLessThanOrEqual(1);
    expect(data.maxStatusHeightDrift).toBeLessThanOrEqual(1);
    expect((data.catEnded ?? 0) - (data.catStarted ?? 0)).toBeGreaterThanOrEqual(1800);
    const fullSequencePath = testInfo.outputPath("bot-full-sequence.json");
    await writeFile(fullSequencePath, JSON.stringify(data, null, 2));
    await testInfo.attach("bot-full-sequence", {
      path: fullSequencePath,
      contentType: "application/json",
    });
    expect((await readAudit(page)).cats).toEqual(["1", "2"]);
    const secondTurn = await game(page);
    const legal = secondTurn.game.position.legalMoves.find((entry) => !entry.promotion);
    if (!legal) throw new Error("Expected a legal follow-up move.");
    await observeTurn(page);
    await move(page, legal);
    await expect(page.locator(".bot-status-slot")).toContainText("Letting the cat finish");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator(".bot-status-slot")).toContainText("paused until this tab returns");
    expect((await game(page)).game.position.moves).toHaveLength(3);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The stored proposal resumes immediately: its canceled cat cannot create
    // an invisible old-deadline wait or an animation backlog.
    await expect
      .poll(async () => (await game(page)).game.position.moves.length, { timeout: 1000 })
      .toBe(4);
    await expect(page.locator('[data-cat-ply="4"]')).toBeVisible();
    await expect(page.locator(".cat-layer")).toHaveCount(0);
    const catVisits = (await readAudit(page)).cats;
    expect(new Set(catVisits).size).toBe(catVisits.length);
    const resumed = await turnObservation(page, true);
    expect(resumed.maxBoardDrift).toBeLessThanOrEqual(1);
    expect(resumed.maxScrollDrift).toBeLessThanOrEqual(1);
    expect(resumed.maxStatusHeightDrift).toBeLessThanOrEqual(1);
    const current = await game(page);
    await page.request.post(`/api/games/${current.game.id}/commands`, {
      headers: { Origin: test.info().project.use.baseURL as string },
      data: {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        expectedRevision: current.game.revision,
        action: { type: "resign" },
      },
    });
  } finally {
    if (observing) {
      const data = await turnObservation(page, true);
      const path = testInfo.outputPath("bot-turn-geometry.json");
      await writeFile(path, JSON.stringify(data, null, 2));
      await testInfo.attach("bot-turn-geometry", { path, contentType: "application/json" });
    }
    await context.close();
  }
});
