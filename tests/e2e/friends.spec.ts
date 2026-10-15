import { randomUUID } from "node:crypto";
import {
  type GameCommand,
  gameCommandSchema,
  gameViewSchema,
  openRoomsSchema,
  type RulesetId,
} from "@chess-room/contracts";
import { applyEngineMove, createEngineState } from "@chess-room/game-core";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Route,
  type WebSocketRoute,
} from "@playwright/test";
import { Pool } from "pg";
import { test } from "./fixtures";

type Players = {
  host: Page;
  friend: Page;
  contexts: BrowserContext[];
  invitation: string;
  pageErrors: string[];
};

const SESSION_BUDGET_WINDOW_MS = 60_050;
const SESSION_BUDGET = 18;
const sessionReservations: number[] = [];
let firstTestInWorker = true;
let reservedForCurrentTest = 2;

test.beforeEach(async ({ browser: _browser }, testInfo) => {
  // Reserve guest-session requests, including recovery with an existing
  // cookie, without changing the production rate guard.
  // A replacement worker cannot remember the previous worker's reservations.
  reservedForCurrentTest = testInfo.tags.includes("@three-session-requests") ? 3 : 2;
  const recoveryWait = firstTestInWorker && testInfo.workerIndex > 0 ? SESSION_BUDGET_WINDOW_MS : 0;
  firstTestInWorker = false;
  if (recoveryWait > 0) {
    testInfo.setTimeout(testInfo.timeout + recoveryWait);
    await new Promise((resolve) => setTimeout(resolve, recoveryWait));
  }
  while (true) {
    const now = Date.now();
    while (
      sessionReservations[0] !== undefined &&
      sessionReservations[0] + SESSION_BUDGET_WINDOW_MS <= now
    )
      sessionReservations.shift();
    if (sessionReservations.length + reservedForCurrentTest <= SESSION_BUDGET) {
      sessionReservations.push(...Array.from({ length: reservedForCurrentTest }, () => now));
      return;
    }
    const wait = (sessionReservations[0] ?? now) + SESSION_BUDGET_WINDOW_MS - now;
    testInfo.setTimeout(testInfo.timeout + wait);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
});

test.afterEach(() => {
  // Retain slots through the end of the test: session requests happen after
  // its reservation, so expiring slots from its start can release them early.
  const completedAt = Date.now();
  sessionReservations.splice(
    -reservedForCurrentTest,
    reservedForCurrentTest,
    ...Array.from({ length: reservedForCurrentTest }, () => completedAt),
  );
});

async function createRoom(
  browser: Browser,
  options: {
    mode?: RulesetId;
    time?: string;
    mobile?: boolean;
    cats?: { host: number; guest: number };
    reducedMotion?: "reduce" | "no-preference";
    hostName?: string;
    visibility?: "private" | "open";
  } = {},
): Promise<Players> {
  const hostContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    reducedMotion: options.reducedMotion ?? "no-preference",
    ...(options.mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : {}),
  });
  const friendContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const host = await hostContext.newPage();
  const friend = await friendContext.newPage();
  const pageErrors: string[] = [];
  host.on("pageerror", (error) => pageErrors.push(error.message));
  friend.on("pageerror", (error) => pageErrors.push(error.message));
  await host.goto("/");
  await host.getByLabel("Your display name").fill(options.hostName ?? "Alex");
  await host.getByLabel("Your pieces").selectOption("white");
  const mode = options.mode ?? "standard";
  await host
    .getByRole("radio", {
      name:
        mode === "standard"
          ? /Standard chess/
          : mode === "three-check"
            ? /Three-check/
            : mode === "chaos-cat"
              ? /Chaos Cat/
              : /Cat Chess/,
    })
    .check();
  if (options.cats) {
    await setCatChance(host, "Your cat", options.cats.host);
    await setCatChance(host, "Friend’s cat", options.cats.guest);
  }
  if (options.time) await host.getByLabel("Time control").selectOption(options.time);
  const open = options.visibility === "open";
  if (open) await host.getByRole("radio", { name: /Open lobby/ }).check();
  await host
    .getByRole("button", { name: open ? "Create open room" : "Create private room" })
    .click();
  await expect(
    host.getByRole("heading", {
      name: open ? "Waiting for an opponent" : "Waiting for your friend",
    }),
  ).toBeVisible();
  const invitation = open ? "" : await host.getByLabel("Private invitation link").inputValue();
  return { host, friend, contexts: [hostContext, friendContext], invitation, pageErrors };
}

async function setCatChance(page: Page, label: string, value: number) {
  const slider = page.getByRole("slider", { name: label, exact: true });
  await slider.focus();
  if (value === 100) await page.keyboard.press("End");
  else {
    await page.keyboard.press("Home");
    for (let step = -100; step < value; step++) await page.keyboard.press("ArrowRight");
  }
  await expect(slider).toHaveValue(String(value));
}

async function readGame(page: Page) {
  const id = await page.evaluate(() => localStorage.getItem("chess-room.current-game"));
  if (!id) throw new Error("The browser has no current room.");
  const response = await page.request.get(`/api/games/${id}`);
  expect(response.status()).toBe(200);
  return gameViewSchema.parse(await response.json());
}

async function holdNextCommand(
  page: Page,
  transform: (command: GameCommand) => GameCommand = (command) => command,
) {
  const commands: GameCommand[] = [];
  let release = () => {};
  let entered = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pattern = /\/api\/games\/[^/]+\/commands$/;
  const handler = async (route: Route) => {
    const command = gameCommandSchema.parse(route.request().postDataJSON());
    commands.push(command);
    if (commands.length === 1) {
      entered();
      await released;
    }
    await route.continue({ postData: JSON.stringify(transform(command)) });
  };
  await page.route(pattern, handler);
  return {
    commands,
    requested,
    release,
    async dispose() {
      release();
      await page.unroute(pattern, handler);
    },
  };
}

async function auditCatVisits(page: Page) {
  await page.evaluate(() => {
    const visits: string[] = [];
    Reflect.set(window, "catVisitAudit", visits);
    const stage = document.querySelector(".board-stage");
    if (!stage) throw new Error("The board stage is missing.");
    new MutationObserver((mutations) => {
      for (const mutation of mutations)
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches("[data-cat-ply]")) visits.push(node.dataset.catPly ?? "");
          for (const target of node.querySelectorAll<HTMLElement>("[data-cat-ply]"))
            visits.push(target.dataset.catPly ?? "");
        }
    }).observe(stage, { childList: true, subtree: true });
  });
}

async function joinRoom(players: Players): Promise<void> {
  await players.friend.goto(players.invitation);
  await players.friend.getByLabel("Your display name").fill("Sam");
  await players.friend.getByRole("button", { name: "Join private room" }).click();
  await expect(players.host.getByRole("heading", { name: "Your move", exact: true })).toBeVisible();
  await expect(
    players.friend.getByRole("heading", { name: "Alex’s move", exact: true }),
  ).toBeVisible();
  await expect(players.host.getByText("Connected", { exact: true })).toBeVisible();
  await expect(players.friend.getByText("Connected", { exact: true })).toBeVisible();
  expect(new URL(players.friend.url()).hash).toBe("");
}

async function move(page: Page, from: string, to: string): Promise<void> {
  await expect(page.locator(`[data-square="${from}"]`)).toHaveAttribute("aria-disabled", "false");
  await page.locator(`[data-square="${from}"]`).click();
  await expect(page.locator(`[data-square="${to}"]`)).toHaveAttribute(
    "aria-label",
    /legal destination/,
  );
  await page.locator(`[data-square="${to}"]`).click();
}

async function keyboardMove(page: Page, from: string, to: string): Promise<void> {
  const source = page.locator(`[data-square="${from}"]`);
  const target = page.locator(`[data-square="${to}"]`);
  await expect(source).toHaveAttribute("aria-disabled", "false");
  await page.locator('.chessboard button[tabindex="0"]').focus();

  async function navigate(index: number) {
    const current = Number(
      await page.locator(".chessboard button:focus").getAttribute("data-index"),
    );
    const rows = Math.floor(index / 8) - Math.floor(current / 8);
    const columns = (index % 8) - (current % 8);
    for (let step = 0; step < Math.abs(rows); step++)
      await page.keyboard.press(rows < 0 ? "ArrowUp" : "ArrowDown");
    for (let step = 0; step < Math.abs(columns); step++)
      await page.keyboard.press(columns < 0 ? "ArrowLeft" : "ArrowRight");
  }

  await navigate(Number(await source.getAttribute("data-index")));
  await expect(source).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(target).toHaveAttribute("aria-label", /legal destination/);
  await navigate(Number(await target.getAttribute("data-index")));
  await expect(target).toBeFocused();
  await page.keyboard.press("Enter");
}

async function closePlayers(players: Players): Promise<void> {
  await Promise.all(players.contexts.map((context) => context.close()));
  expect(players.pageErrors).toEqual([]);
}

function uniqueName(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function changeDisplayName(page: Page, name: string) {
  const trigger = page.getByRole("button", { name: "Change display name", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Change display name", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("New display name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Save name", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("header").getByText(name, { exact: true })).toBeVisible();
}

async function joinOpenRoom(page: Page, hostName: string, displayName: string) {
  const rooms = page.getByRole("region", { name: "Open rooms", exact: true });
  await expect(rooms).toBeVisible();
  const card = rooms.getByRole("listitem").filter({ hasText: hostName });
  await expect(card).toHaveCount(1);
  const join = card.getByRole("button", { name: `Join ${hostName}’s room`, exact: true });
  await join.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Join open room", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Display name to join", { exact: true }).fill(displayName);
  await dialog.getByRole("button", { name: "Join room", exact: true }).focus();
  await page.keyboard.press("Enter");
}

test("a legal move displays immediately while the real command is held and cannot be sent twice", async ({
  browser,
}, testInfo) => {
  const players = await createRoom(browser);
  const gate = await holdNextCommand(players.host);
  try {
    await joinRoom(players);
    await move(players.host, "e2", "e4");
    await gate.requested;
    await expect(players.host.locator('[data-square="e2"]')).toHaveAttribute("aria-label", /empty/);
    await expect(players.host.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.host.getByRole("table", { name: "Chess board" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    await expect(players.host.locator('[data-square="d2"]')).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await players.host.locator('[data-square="d2"]').click({ force: true });
    await players.host.locator('[data-square="d4"]').click({ force: true });
    await expect(players.host.locator('[data-square="d2"]')).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(gate.commands).toHaveLength(1);
    await expect(players.host.getByText("0 moves", { exact: true })).toBeVisible();
    await players.host.screenshot({
      path: testInfo.outputPath("immediate-move-preview.png"),
      fullPage: true,
    });
    const stored = (await readGame(players.host)).game;
    expect(stored.position.moves).toHaveLength(0);
    expect(stored.position.board).toContainEqual({ square: "e2", type: "p", color: "white" });
    await expect(players.friend.locator('[data-square="e2"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    gate.release();
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.host.getByText("1 move", { exact: true })).toBeVisible();
    await expect(players.host.getByRole("table", { name: "Chess board" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect((await readGame(players.host)).game.position.moves).toHaveLength(1);
  } finally {
    await gate.dispose();
    await closePlayers(players);
  }
});

test("a server rejection rolls back an immediate move preview and restores legal input", async ({
  browser,
}) => {
  const players = await createRoom(browser);
  const gate = await holdNextCommand(players.host, (command) => ({
    ...command,
    expectedRevision: command.expectedRevision - 1,
  }));
  try {
    await joinRoom(players);
    await move(players.host, "e2", "e4");
    await gate.requested;
    await expect(players.host.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    gate.release();
    await expect(players.host.getByRole("alert")).toContainText(
      "The game changed. Refresh and try again.",
    );
    await expect(players.host.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /empty/);
    await expect(players.host.locator('[data-square="e2"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.host.locator('[data-square="e2"]')).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await expect(players.host.getByText("0 moves", { exact: true })).toBeVisible();
    expect((await readGame(players.friend)).game.position.moves).toHaveLength(0);
    await gate.dispose();
    await players.host.getByRole("button", { name: "Dismiss error" }).click();
    await move(players.host, "e2", "e4");
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
  } finally {
    await gate.dispose();
    await closePlayers(players);
  }
});

test("a lost command acknowledgement retries safely without repeating a move or reverting a changed name", async ({
  browser,
}) => {
  const players = await createRoom(browser);
  try {
    await joinRoom(players);
    const commands: unknown[] = [];
    await players.host.route(/\/api\/games\/[^/]+\/commands$/, async (route) => {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort("failed");
      } else await route.continue();
    });
    await players.host.bringToFront();
    await move(players.host, "e2", "e4");
    await expect(players.host.getByRole("button", { name: "Retry command" })).toBeVisible();
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    const renamed = uniqueName("Retry");
    await changeDisplayName(players.host, renamed);
    await expect(
      players.friend.locator(".player-identity strong").filter({ hasText: renamed }),
    ).toBeVisible();
    const retried = players.host.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/games\/[^/]+\/commands$/.test(new URL(response.url()).pathname) &&
        response.status() === 200,
    );
    await players.host.getByRole("button", { name: "Retry command" }).click();
    // The immutable original receipt still has its old name. Applying it must
    // preserve the current session and player names rather than replaying them.
    expect(gameViewSchema.parse(await (await retried).json()).game.players.white?.displayName).toBe(
      "Alex",
    );
    await expect(players.host.getByRole("alert")).toHaveCount(0);
    await expect(players.host.getByText("1 move", { exact: true })).toBeVisible();
    await expect(players.host.locator("header").getByText(renamed, { exact: true })).toBeVisible();
    await expect(
      players.host.locator(".player-identity strong").filter({ hasText: renamed }),
    ).toBeVisible();
    expect((await readGame(players.host)).game.players.white?.displayName).toBe(renamed);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  } finally {
    await closePlayers(players);
  }
});

test("two independent friends complete a keyboard-only checkmate, resume, and agree a rematch", async ({
  browser,
}) => {
  const players = await createRoom(browser);
  try {
    await joinRoom(players);
    await keyboardMove(players.host, "f2", "f3");
    await keyboardMove(players.friend, "e7", "e5");
    await players.host.reload();
    await expect(players.host.locator('[data-square="f3"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await keyboardMove(players.host, "g2", "g4");
    await keyboardMove(players.friend, "d8", "h4");
    await expect(players.host.getByRole("heading", { name: "Sam wins" })).toBeVisible();
    await expect(
      players.friend.getByRole("paragraph").filter({ hasText: /^Checkmate$/ }),
    ).toBeVisible();
    await expect(players.host.getByRole("cell", { name: "Qh4#", exact: true })).toBeVisible();
    await players.host.getByRole("button", { name: "Lobby", exact: true }).click();
    await players.host.getByRole("button", { name: "Return to previous room" }).click();
    await expect(players.host.getByRole("heading", { name: "Sam wins" })).toBeVisible();
    const originalGame = await players.host.evaluate(() =>
      localStorage.getItem("chess-room.current-game"),
    );
    await players.host.getByRole("button", { name: "Request rematch" }).click();
    await expect(players.friend.getByRole("button", { name: "Accept rematch" })).toBeVisible();
    await players.friend.getByRole("button", { name: "Accept rematch" }).click();
    await players.host.getByRole("button", { name: "Go to rematch" }).click();
    await players.friend.getByRole("button", { name: "Go to rematch" }).click();
    await expect(
      players.friend.getByRole("heading", { name: "Your move", exact: true }),
    ).toBeVisible();
    await expect(
      players.host.getByRole("heading", { name: "Sam’s move", exact: true }),
    ).toBeVisible();
    expect(
      await players.host.evaluate(() => localStorage.getItem("chess-room.current-game")),
    ).not.toBe(originalGame);
    await expect(players.host.getByText("0 moves", { exact: true })).toBeVisible();
  } finally {
    await closePlayers(players);
  }
});

test("host refresh recovers invitation safely and completed games reject a consumed invitation", {
  tag: "@three-session-requests",
}, async ({ browser }) => {
  const players = await createRoom(browser);
  try {
    await players.host.reload();
    await expect(
      players.host.getByRole("button", { name: "Create invitation link" }),
    ).toBeVisible();
    await players.host.getByRole("button", { name: "Create invitation link" }).click();
    const rotated = await players.host.getByLabel("Private invitation link").inputValue();
    expect(rotated).not.toBe(players.invitation);
    players.invitation = rotated;
    await joinRoom(players);
    await players.host.getByRole("button", { name: "Resign", exact: true }).click();
    await expect(players.host.getByRole("dialog", { name: "Resign this game?" })).toBeVisible();
    await players.host.getByRole("button", { name: "Keep playing" }).click();
    await expect(
      players.host.getByRole("heading", { name: "Your move", exact: true }),
    ).toBeVisible();
    await players.host.getByRole("button", { name: "Resign", exact: true }).click();
    await players.host.getByRole("button", { name: "Resign game" }).click();
    await expect(players.friend.getByRole("heading", { name: "Sam wins" })).toBeVisible();
    const stranger = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const page = await stranger.newPage();
      await page.goto(rotated);
      await page.getByLabel("Your display name").fill("Taylor");
      await page.getByRole("button", { name: "Join private room" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("table", { name: "Chess board" })).toHaveCount(0);
    } finally {
      await stranger.close();
    }
  } finally {
    await closePlayers(players);
  }
});

test("keyboard moves, mobile layout, draw offers, and offline recovery converge", async ({
  browser,
}) => {
  const players = await createRoom(browser, { mobile: true, time: "10+5" });
  try {
    await joinRoom(players);
    expect(
      await players.host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await players.host.locator('[data-square="e2"]').focus();
    await players.host.keyboard.press("Enter");
    await players.host.keyboard.press("ArrowUp");
    await players.host.keyboard.press("ArrowUp");
    await expect(players.host.locator('[data-square="e4"]')).toBeFocused();
    await players.host.keyboard.press("Enter");
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await players.contexts[0]?.setOffline(true);
    await expect(players.host.getByText("Reconnecting…", { exact: true })).toBeVisible();
    await move(players.friend, "e7", "e5");
    await players.contexts[0]?.setOffline(false);
    await expect(players.host.getByText("Connected", { exact: true })).toBeVisible();
    await expect(players.host.locator('[data-square="e5"]')).toHaveAttribute(
      "aria-label",
      /black pawn/,
    );
    await players.host.getByRole("button", { name: "Offer draw" }).click();
    await expect(
      players.friend.getByRole("heading", { name: "Your friend offered a draw" }),
    ).toBeVisible();
    await players.friend.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(players.host.getByRole("button", { name: "Offer draw" })).toBeEnabled();
    await players.host.getByRole("button", { name: "Offer draw" }).click();
    await players.friend.getByRole("button", { name: "Accept draw", exact: true }).click();
    await expect(players.host.getByRole("heading", { name: "Game drawn" })).toBeVisible();
    await expect(
      players.friend.getByRole("paragraph").filter({ hasText: /^Draw by agreement$/ }),
    ).toBeVisible();
  } finally {
    await closePlayers(players);
  }
});

test("a real promotion presents every choice and supports underpromotion", async ({ browser }) => {
  const players = await createRoom(browser);
  let gate: Awaited<ReturnType<typeof holdNextCommand>> | null = null;
  try {
    await joinRoom(players);
    for (const [from, to, actor] of [
      ["a2", "a4", "host"],
      ["h7", "h5", "friend"],
      ["a4", "a5", "host"],
      ["h5", "h4", "friend"],
      ["a5", "a6", "host"],
      ["h4", "h3", "friend"],
      ["a6", "b7", "host"],
      ["h3", "g2", "friend"],
    ] as const)
      await move(players[actor], from, to);
    await move(players.host, "b7", "a8");
    const dialog = players.host.getByRole("dialog", { name: "Choose your promotion" });
    await expect(dialog).toBeVisible();
    for (const name of ["queen", "rook", "bishop", "knight"])
      await expect(dialog.getByRole("button", { name, exact: true })).toBeEnabled();
    gate = await holdNextCommand(players.host);
    await dialog.getByRole("button", { name: "knight", exact: true }).click();
    await gate.requested;
    await expect(players.host.locator('[data-square="a8"]')).toHaveAttribute(
      "aria-label",
      /white knight/,
    );
    await expect(players.host.locator('[data-square="b7"]')).toHaveAttribute("aria-label", /empty/);
    await expect(players.friend.locator('[data-square="a8"]')).toHaveAttribute(
      "aria-label",
      /black rook/,
    );
    expect((await readGame(players.host)).game.position.moves).toHaveLength(8);
    gate.release();
    await expect(players.friend.locator('[data-square="a8"]')).toHaveAttribute(
      "aria-label",
      /white knight/,
    );
    await expect(players.host.getByRole("cell", { name: "bxa8=N", exact: true })).toBeVisible();
  } finally {
    await gate?.dispose();
    await closePlayers(players);
  }
});

test("immediate move previews relocate both castling pieces and remove an en-passant victim", async ({
  browser,
}) => {
  const players = await createRoom(browser);
  let gate: Awaited<ReturnType<typeof holdNextCommand>> | null = null;
  try {
    await joinRoom(players);
    for (const [from, to, actor] of [
      ["e2", "e4", "host"],
      ["a7", "a6", "friend"],
      ["g1", "f3", "host"],
      ["a6", "a5", "friend"],
      ["f1", "e2", "host"],
      ["h7", "h6", "friend"],
    ] as const)
      await move(players[actor], from, to);
    gate = await holdNextCommand(players.host);
    await move(players.host, "e1", "g1");
    await gate.requested;
    await expect(players.host.locator('[data-square="g1"]')).toHaveAttribute(
      "aria-label",
      /white king/,
    );
    await expect(players.host.locator('[data-square="f1"]')).toHaveAttribute(
      "aria-label",
      /white rook/,
    );
    for (const square of ["e1", "h1"])
      await expect(players.host.locator(`[data-square="${square}"]`)).toHaveAttribute(
        "aria-label",
        /empty/,
      );
    expect((await readGame(players.host)).game.position.moves).toHaveLength(6);
    gate.release();
    await expect(players.friend.locator('[data-square="g1"]')).toHaveAttribute(
      "aria-label",
      /white king/,
    );
    await gate.dispose();
    gate = null;
    for (const [from, to, actor] of [
      ["h6", "h5", "friend"],
      ["e4", "e5", "host"],
      ["d7", "d5", "friend"],
    ] as const)
      await move(players[actor], from, to);
    gate = await holdNextCommand(players.host);
    await move(players.host, "e5", "d6");
    await gate.requested;
    await expect(players.host.locator('[data-square="d6"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    for (const square of ["e5", "d5"])
      await expect(players.host.locator(`[data-square="${square}"]`)).toHaveAttribute(
        "aria-label",
        /empty/,
      );
    const stored = (await readGame(players.host)).game;
    expect(stored.position.moves).toHaveLength(10);
    expect(stored.position.board).toContainEqual({ square: "d5", type: "p", color: "black" });
    gate.release();
    await expect(players.friend.locator('[data-square="d6"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.friend.locator('[data-square="d5"]')).toHaveAttribute(
      "aria-label",
      /empty/,
    );
    await expect(players.host.getByRole("cell", { name: "exd6", exact: true })).toBeVisible();
  } finally {
    await gate?.dispose();
    await closePlayers(players);
  }
});

test("three-check mode persists its rules and check counters after reconnect", async ({
  browser,
}) => {
  const players = await createRoom(browser, { mode: "three-check" });
  try {
    await joinRoom(players);
    await expect(
      players.host.getByRole("heading", { name: "Three-check", exact: true }),
    ).toBeVisible();
    await move(players.host, "e2", "e4");
    await move(players.friend, "f7", "f6");
    await move(players.host, "d1", "h5");
    await expect(
      players.friend
        .getByRole("paragraph")
        .filter({ hasText: /^Black is in check\. Protect the king\.$/ }),
    ).toBeVisible();
    await expect(players.host.getByRole("group", { name: "Checks delivered" })).toContainText(
      "1 / 3",
    );
    await players.host.reload();
    await expect(players.host.getByRole("group", { name: "Checks delivered" })).toContainText(
      "1 / 3",
    );
    await expect(players.host.locator('[data-square="h5"]')).toHaveAttribute(
      "aria-label",
      /white queen/,
    );
  } finally {
    await closePlayers(players);
  }
});

test("Catchess sliders keep independent signed chances and omit cat settings in other modes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("radio", { name: /Cat Chess/ }).check();
  const host = page.getByRole("slider", { name: "Your cat", exact: true });
  const guest = page.getByRole("slider", { name: "Friend’s cat", exact: true });
  await expect(host).toHaveValue("25");
  await expect(guest).toHaveValue("25");
  await setCatChance(page, "Your cat", -100);
  await expect(host).toHaveAttribute("aria-valuetext", "100% evil");
  await expect(guest).toHaveValue("25");
  await setCatChance(page, "Your cat", 0);
  await expect(host).toHaveAttribute("aria-valuetext", "Off");
  await setCatChance(page, "Friend’s cat", 100);
  await page.keyboard.press("ArrowLeft");
  await expect(guest).toHaveValue("99");
  await expect(guest).toHaveAttribute("aria-valuetext", "99% helpful");
  await page.getByRole("radio", { name: /Standard chess/ }).check();
  await expect(page.getByRole("slider")).toHaveCount(0);
  let body: unknown;
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: { displayName: "Alex", expiresAt: Date.now() + 60_000 } }),
    }),
  );
  await page.route("**/api/games", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "TEST_REQUEST_CAPTURE", message: "Captured request" },
      }),
    });
  });
  await page.getByLabel("Your display name").fill("Alex");
  await page.getByRole("button", { name: "Create private room" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(body).toEqual({ rulesetId: "standard", color: "random", timeControl: "untimed" });
});

test("Catchess previews only the chess move and both friends see cat visits when a snapshot beats its socket event", async ({
  browser,
}) => {
  const players = await createRoom(browser, {
    mode: "catchess",
    cats: { host: 100, guest: 100 },
  });
  const delayedEvents: (() => void)[] = [];
  let delayUpdates = true;
  await players.friend.routeWebSocket(/\/socket\.io\//, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (delayUpdates && typeof message === "string" && message.includes('"game:updated"'))
        delayedEvents.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  const gate = await holdNextCommand(players.host);
  try {
    await joinRoom(players);
    await auditCatVisits(players.host);
    await auditCatVisits(players.friend);
    await players.host.bringToFront();
    await move(players.host, "e2", "e4");
    await gate.requested;
    await expect(players.host.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.host.locator('.chessboard button[aria-label*="white pawn"]')).toHaveCount(
      8,
    );
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    await expect(players.host.locator(".cat-history-effect")).toHaveCount(0);
    expect((await readGame(players.host)).game.position.moves).toHaveLength(0);
    gate.release();
    await expect(players.host.locator('[data-cat-action="add"]')).toHaveAttribute(
      "data-cat-edge",
      "bottom",
    );
    await expect.poll(() => delayedEvents.length).toBeGreaterThan(0);
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    const snapshot = players.friend.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /\/api\/games\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.status() === 200,
    );
    await players.friend.bringToFront();
    await snapshot;
    await expect(players.friend.locator('[data-cat-action="add"]')).toBeVisible();
    await expect(players.friend.locator('[data-cat-action="add"]')).toHaveAttribute(
      "data-cat-edge",
      "top",
    );
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    const game = (await readGame(players.friend)).game;
    const added = game.position.catEffects?.[0];
    expect(added?.action).toBe("add");
    await expect(players.friend.locator('[data-cat-ply="1"]')).toHaveAttribute(
      "data-cat-square",
      added?.square ?? "",
    );
    delayUpdates = false;
    for (const deliver of delayedEvents.splice(0)) deliver();
    await expect(players.friend.locator(".cat-layer")).toHaveCount(0);
    expect(await players.friend.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual([
      "1",
    ]);
    expect(await players.host.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual(["1"]);
    await move(players.friend, "e7", "e5");
    await expect(players.friend.locator('[data-cat-ply="2"]')).toHaveAttribute(
      "data-cat-edge",
      "bottom",
    );
    await expect(players.host.locator('[data-cat-ply="2"]')).toHaveAttribute(
      "data-cat-edge",
      "top",
    );
    await expect(players.host.locator('[data-cat-ply="2"]')).toBeVisible();
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    await expect(players.friend.locator(".cat-layer")).toHaveCount(0);
    for (const page of [players.host, players.friend])
      expect(await page.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual(["1", "2"]);
  } finally {
    delayUpdates = false;
    for (const deliver of delayedEvents.splice(0)) deliver();
    await gate.dispose();
    await closePlayers(players);
  }
});

test("an obsolete HTTP refresh cannot consume a new cat visit after the socket reconnects", async ({
  browser,
}) => {
  const players = await createRoom(browser, {
    mode: "catchess",
    cats: { host: 100, guest: 0 },
  });
  const sockets: WebSocketRoute[] = [];
  const delayedEvents: (() => void)[] = [];
  let holdEvents = false;
  await players.friend.routeWebSocket(/\/socket\.io\//, (socket) => {
    sockets.push(socket);
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (holdEvents && typeof message === "string" && message.includes('"game:updated"'))
        delayedEvents.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  let releaseOld = () => {};
  let oldRequested = () => {};
  let capturedOld = false;
  const released = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    oldRequested = resolve;
  });
  try {
    await joinRoom(players);
    await auditCatVisits(players.friend);
    await players.friend.route(/\/api\/games\/[^/]+$/, async (route) => {
      if (capturedOld) {
        await route.continue();
        return;
      }
      capturedOld = true;
      oldRequested();
      await released;
      // This old refresh receives genuine newer state, after a new socket subscription.
      await route.fulfill({ response: await route.fetch() });
    });
    await players.host.bringToFront();
    await players.friend.bringToFront();
    await requested;
    const original = sockets[0];
    if (!original) throw new Error("The initial socket connection is missing.");
    await original.close({ code: 1001, reason: "Transport interruption" });
    await expect(players.friend.getByText("Reconnecting…", { exact: true })).toBeVisible();
    await expect.poll(() => sockets.length).toBeGreaterThanOrEqual(2);
    await expect(players.friend.getByText("Connected", { exact: true })).toBeVisible();
    await expect(players.friend.getByText("0 moves", { exact: true })).toBeVisible();
    holdEvents = true;
    await move(players.host, "e2", "e4");
    await expect(players.host.getByText("1 move", { exact: true })).toBeVisible();
    await expect.poll(() => delayedEvents.length).toBeGreaterThan(0);
    const responsePromise = players.friend.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /\/api\/games\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.status() === 200,
    );
    releaseOld();
    const obsoleteResponse = await responsePromise;
    expect(gameViewSchema.parse(await obsoleteResponse.json()).game.position.moves).toHaveLength(1);
    await obsoleteResponse.finished();
    await players.friend.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(players.friend.getByText("0 moves", { exact: true })).toBeVisible();
    await expect(players.friend.locator('[data-square="e2"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.friend.locator(".cat-history-effect")).toHaveCount(0);
    await expect(players.friend.locator(".cat-layer")).toHaveCount(0);
    holdEvents = false;
    for (const deliver of delayedEvents.splice(0)) deliver();
    await expect(players.friend.locator('[data-cat-ply="1"]')).toBeVisible();
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    await expect(players.friend.getByText("1 move", { exact: true })).toBeVisible();
    await expect(players.friend.locator(".cat-layer")).toHaveCount(0);
    expect(await players.friend.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual([
      "1",
    ]);
  } finally {
    releaseOld();
    holdEvents = false;
    for (const deliver of delayedEvents.splice(0)) deliver();
    await closePlayers(players);
  }
});

test("Catchess animates committed pawn actions in both orientations once and restores history", async ({
  browser,
}, testInfo) => {
  const players = await createRoom(browser, {
    mode: "catchess",
    cats: { host: 100, guest: -100 },
    mobile: true,
  });
  try {
    await expect(players.host.getByRole("group", { name: "Cats at this table" })).toContainText(
      "100% helpful",
    );
    await expect(players.host.getByRole("group", { name: "Cats at this table" })).toContainText(
      "100% evil",
    );
    await joinRoom(players);
    await auditCatVisits(players.host);
    await auditCatVisits(players.friend);
    await players.host.bringToFront();
    let dropped = false;
    await players.host.route(/\/api\/games\/[^/]+\/commands$/, async (route) => {
      if (!dropped && route.request().postDataJSON().action.type === "move") {
        dropped = true;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        // Lose the HTTP acknowledgement after the independently committed socket event arrives.
        await expect(players.host.locator('[data-cat-action="add"]')).toBeVisible();
        await route.abort("failed");
      } else await route.continue();
    });
    await move(players.host, "e2", "e4");
    await expect(players.host.locator('[data-cat-action="add"]')).toBeVisible();
    await expect(players.friend.locator('[data-cat-action="add"]')).toHaveAttribute(
      "data-cat-edge",
      "top",
    );
    await expect(players.host.getByRole("button", { name: "Retry command" })).toBeVisible();
    await players.host.getByRole("button", { name: "Retry command" }).click();
    await expect(players.host.getByRole("alert")).toHaveCount(0);
    const first = (await readGame(players.host)).game;
    const added = first.position.catEffects?.[0];
    expect(added?.action).toBe("add");
    expect(
      first.position.board.filter((piece) => piece.type === "p" && piece.color === "white"),
    ).toHaveLength(9);
    await players.host.waitForFunction(
      () =>
        document.querySelector('[data-cat-action="add"]')?.getAttribute("data-cat-phase") === "paw",
      undefined,
      { polling: "raf", timeout: 5000 },
    );
    await expect(
      players.host.locator(`[data-square="${added?.square}"] .board-piece`),
    ).toBeHidden();
    await players.host.screenshot({
      path: testInfo.outputPath("catchess-white-cat.png"),
      fullPage: true,
    });
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    expect(await players.host.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual(["1"]);
    await players.friend.bringToFront();
    await move(players.friend, "e7", "e5");
    const removal = players.friend.locator('[data-cat-action="remove"]');
    await expect(removal).toHaveAttribute("data-cat-edge", "bottom");
    await expect(players.host.locator('[data-cat-action="remove"]')).toHaveAttribute(
      "data-cat-edge",
      "top",
    );
    await expect(players.host.locator('[data-cat-action="remove"]')).toBeVisible();
    await players.host.bringToFront();
    await players.host.waitForFunction(
      () =>
        document.querySelector('[data-cat-action="remove"]')?.getAttribute("data-cat-phase") ===
        "paw",
      undefined,
      { polling: "raf", timeout: 5000 },
    );
    await players.host.screenshot({
      path: testInfo.outputPath("opponent-cat-visit.png"),
      fullPage: true,
    });
    const final = (await readGame(players.friend)).game;
    const removed = final.position.catEffects?.[1];
    expect(removed?.action).toBe("remove");
    expect(
      final.position.board.filter((piece) => piece.type === "p" && piece.color === "black"),
    ).toHaveLength(7);
    expect(removed?.square).toBeTruthy();
    const target = await removal.boundingBox();
    const square = await players.friend.locator(`[data-square="${removed?.square}"]`).boundingBox();
    expect(target).not.toBeNull();
    expect(square).not.toBeNull();
    expect(Math.abs((target?.x ?? 0) - (square?.x ?? 0))).toBeLessThan(1);
    expect(Math.abs((target?.y ?? 0) - (square?.y ?? 0))).toBeLessThan(1);
    await players.friend.screenshot({
      path: testInfo.outputPath("catchess-black-cat.png"),
      fullPage: true,
    });
    await expect(players.friend.locator(".cat-layer")).toHaveCount(0);
    expect(await players.friend.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual([
      "1",
      "2",
    ]);
    expect(await players.host.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual([
      "1",
      "2",
    ]);
    await expect(players.host.locator(".cat-history-effect")).toHaveCount(2);
    await players.host.reload();
    await expect(players.host.locator(".cat-history-effect")).toHaveCount(2);
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    expect((await readGame(players.host)).game.position.fen).toBe(final.position.fen);
    expect(
      await players.host.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await players.host.getByRole("button", { name: "Resign", exact: true }).click();
    await players.host.getByRole("button", { name: "Resign game" }).click();
    await players.host.getByRole("button", { name: "Request rematch" }).click();
    await players.friend.getByRole("button", { name: "Accept rematch" }).click();
    await players.host.getByRole("button", { name: "Go to rematch" }).click();
    await expect(
      players.host.getByRole("heading", { name: "Sam’s move", exact: true }),
    ).toBeVisible();
    const rematch = (await readGame(players.host)).game;
    expect(rematch.id).not.toBe(first.id);
    expect(rematch.catchess).toEqual({ white: -100, black: 100 });
    await expect(players.host.getByRole("group", { name: "Cats at this table" })).toContainText(
      "100% helpful",
    );
  } finally {
    await closePlayers(players);
  }
});

test("Catchess off setting and reduced motion preserve real pawn changes without roaming animation", async ({
  browser,
}) => {
  const players = await createRoom(browser, {
    mode: "catchess",
    cats: { host: 100, guest: 0 },
    reducedMotion: "reduce",
    mobile: true,
  });
  try {
    await joinRoom(players);
    await move(players.host, "e2", "e4");
    await expect(players.friend.locator(".cat-history-effect")).toContainText([/added a pawn/]);
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    const first = (await readGame(players.host)).game;
    expect(
      first.position.board.filter((piece) => piece.type === "p" && piece.color === "white"),
    ).toHaveLength(9);
    const square = first.position.catEffects?.[0]?.square;
    await expect(players.host.locator(`[data-square="${square}"] .board-piece`)).toBeVisible();
    await move(players.friend, "e7", "e5");
    const next = (await readGame(players.host)).game;
    expect(next.position.catEffects?.[1]).toEqual({ ply: 2, color: "black", action: "none" });
    expect(
      next.position.board.filter((piece) => piece.type === "p" && piece.color === "black"),
    ).toHaveLength(8);
    await expect(players.host.locator(".cat-history-effect")).toContainText([
      /added a pawn/,
      /made no change/,
    ]);
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    expect(
      await players.host.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  } finally {
    await closePlayers(players);
  }
});

test(
  "display names change from the keyboard without losing seats, moves or running clocks",
  {
    tag: "@three-session-requests",
  },
  async ({ browser }, testInfo) => {
    const players = await createRoom(browser, { time: "10+5", mobile: true });
    const hostName = uniqueName("Nova");
    const guestName = uniqueName("Sage");
    try {
      await joinRoom(players);
      await move(players.host, "e2", "e4");
      await move(players.friend, "e7", "e5");
      await expect(players.host.getByText("2 moves", { exact: true })).toBeVisible();
      const before = await readGame(players.host);
      expect(before.game.clocks?.runningColor).toBe("white");

      await players.host.getByRole("button", { name: "Change display name", exact: true }).click();
      const cancelled = players.host.getByRole("dialog", {
        name: "Change display name",
        exact: true,
      });
      await expect(cancelled).toBeVisible();
      await players.host.screenshot({
        path: testInfo.outputPath("name-editor.png"),
        fullPage: true,
      });
      await cancelled.getByLabel("New display name", { exact: true }).fill("Not saved");
      await players.host.keyboard.press("Escape");
      await expect(cancelled).toHaveCount(0);
      await expect(players.host.locator("header").getByText("Alex", { exact: true })).toBeVisible();
      await expect(
        players.host.getByRole("button", { name: "Change display name", exact: true }),
      ).toBeFocused();

      await changeDisplayName(players.host, hostName);
      await expect(
        players.friend.getByRole("heading", { name: `${hostName}’s move`, exact: true }),
      ).toBeVisible();
      await expect(
        players.friend.locator(".player-identity strong").filter({ hasText: hostName }),
      ).toBeVisible();
      await changeDisplayName(players.friend, guestName);
      await expect(
        players.host.locator(".player-identity strong").filter({ hasText: guestName }),
      ).toBeVisible();
      const renamed = await readGame(players.host);
      expect(renamed.seat).toBe(before.seat);
      expect(renamed.game.id).toBe(before.game.id);
      expect(renamed.game.revision).toBe(before.game.revision);
      expect(renamed.game.position).toEqual(before.game.position);
      expect(renamed.game.players).toEqual({
        white: { displayName: hostName },
        black: { displayName: guestName },
      });
      expect(renamed.game.clocks?.runningColor).toBe(before.game.clocks?.runningColor);
      expect(renamed.game.clocks?.turnStartedAt).toBe(before.game.clocks?.turnStartedAt);
      expect(renamed.game.clocks?.blackMs).toBe(before.game.clocks?.blackMs);
      expect(renamed.game.clocks?.whiteMs).toBeLessThanOrEqual(before.game.clocks?.whiteMs ?? 0);

      await players.host.reload();
      await expect(
        players.host.locator("header").getByText(hostName, { exact: true }),
      ).toBeVisible();
      await expect(players.host.getByText("2 moves", { exact: true })).toBeVisible();
      expect((await readGame(players.host)).seat).toBe("white");
      await players.friend.reload();
      await expect(
        players.friend.locator("header").getByText(guestName, { exact: true }),
      ).toBeVisible();
      expect((await readGame(players.friend)).seat).toBe("black");
      await keyboardMove(players.host, "g1", "f3");
      await expect(players.friend.locator('[data-square="f3"]')).toHaveAttribute(
        "aria-label",
        /white knight/,
      );
      await expect(
        players.host.getByRole("heading", { name: `${guestName}’s move`, exact: true }),
      ).toBeVisible();
      await expect(players.host.getByText("3 moves", { exact: true })).toBeVisible();
      expect(
        await players.host.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await players.host.screenshot({
        path: testInfo.outputPath("changed-display-names.png"),
        fullPage: true,
      });

      // A session failure must close the editor permanently. Recovering a
      // still-valid cookie later must not reopen its abandoned draft.
      await players.host.route(
        /\/api\/session\/name$/,
        async (route) => {
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "SESSION_REQUIRED", message: "Your guest session has expired." },
            }),
          });
        },
        { times: 1 },
      );
      await players.host.getByRole("button", { name: "Change display name", exact: true }).click();
      const expiredEditor = players.host.getByRole("dialog", {
        name: "Change display name",
        exact: true,
      });
      await expiredEditor.getByLabel("New display name", { exact: true }).fill("Expired draft");
      await expiredEditor.getByRole("button", { name: "Save name", exact: true }).click();
      await expect(expiredEditor).toHaveCount(0);
      await expect(
        players.host.getByRole("button", { name: "Change display name", exact: true }),
      ).toHaveCount(0);
      await expect(players.host.getByRole("alert")).toContainText(
        "Your guest session has expired.",
      );
      await players.host.getByRole("button", { name: "Lobby", exact: true }).click();
      await players.host.getByLabel("Your display name", { exact: true }).fill(hostName);
      await players.host.getByLabel("Your pieces", { exact: true }).selectOption("white");
      await players.host.getByRole("button", { name: "Create private room", exact: true }).click();
      await expect(
        players.host.getByRole("heading", { name: "Waiting for your friend", exact: true }),
      ).toBeVisible();
      await expect(
        players.host.getByRole("button", { name: "Change display name", exact: true }),
      ).toBeVisible();
      await expect(expiredEditor).toHaveCount(0);
      await expect(
        players.host.locator("header").getByText(hostName, { exact: true }),
      ).toBeVisible();
      await expect(players.host.getByLabel("Private invitation link", { exact: true })).toHaveValue(
        /#invite=/,
      );
      const recovered = await readGame(players.host);
      expect(recovered.game.id).not.toBe(before.game.id);
      expect(recovered.game.phase).toBe("waiting");
      expect(recovered.seat).toBe("white");
      expect(recovered.game.players.white?.displayName).toBe(hostName);
    } finally {
      await closePlayers(players);
    }
  },
);

test("a fresh mobile visitor discovers an open room, joins from the keyboard and removes it from discovery", async ({
  browser,
}, testInfo) => {
  const originalName = uniqueName("Open");
  const hostName = uniqueName("Open");
  const players = await createRoom(browser, {
    visibility: "open",
    hostName: originalName,
    mode: "catchess",
    cats: { host: 0, guest: 0 },
    time: "10+5",
  });
  const observerContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  players.contexts.push(observerContext);
  const observer = await observerContext.newPage();
  observer.on("pageerror", (error) => players.pageErrors.push(error.message));
  try {
    await changeDisplayName(players.host, hostName);
    const waiting = await readGame(players.host);
    expect(waiting.game.phase).toBe("waiting");
    expect(waiting.game.visibility).toBe("open");
    await expect(players.host.getByLabel("Private invitation link")).toHaveCount(0);
    await players.friend.setViewportSize({ width: 390, height: 844 });
    await players.friend.goto("/");
    await observer.goto("/");
    const rooms = players.friend.getByRole("region", { name: "Open rooms", exact: true });
    const card = rooms.getByRole("listitem").filter({ hasText: hostName });
    await expect(rooms.getByRole("listitem").filter({ hasText: originalName })).toHaveCount(0);
    await expect(card).toContainText("Cat Chess");
    await expect(card).toContainText("10 minutes + 5 seconds");
    await expect(
      observer
        .getByRole("region", { name: "Open rooms", exact: true })
        .getByRole("listitem")
        .filter({ hasText: hostName }),
    ).toHaveCount(1);
    expect(
      await players.friend.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await players.friend.screenshot({
      path: testInfo.outputPath("open-rooms-mobile.png"),
      fullPage: true,
    });

    await joinOpenRoom(players.friend, hostName, "Robin");
    await expect(
      players.friend.getByRole("dialog", { name: "Join open room", exact: true }),
    ).toHaveCount(0);
    await expect(
      players.host.getByRole("heading", { name: "Your move", exact: true }),
    ).toBeVisible();
    await expect(
      players.friend.getByRole("heading", { name: `${hostName}’s move`, exact: true }),
    ).toBeVisible();
    const joined = await readGame(players.friend);
    expect(joined.game.id).toBe(waiting.game.id);
    expect(joined.seat).toBe("black");
    expect(new URL(players.friend.url()).hash).toBe("");
    await expect(
      observer
        .getByRole("region", { name: "Open rooms", exact: true })
        .getByRole("listitem")
        .filter({ hasText: hostName }),
    ).toHaveCount(0);
    const response = await observer.request.get("/api/lobbies");
    expect(response.status()).toBe(200);
    expect(openRoomsSchema.parse(await response.json()).rooms.map((room) => room.id)).not.toContain(
      waiting.game.id,
    );
    await move(players.host, "e2", "e4");
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
  } finally {
    await closePlayers(players);
  }
});

test("private invitation rooms stay absent from public discovery for an anonymous visitor", async ({
  browser,
}) => {
  const hostName = uniqueName("Private");
  const players = await createRoom(browser, { hostName });
  try {
    const privateRoom = (await readGame(players.host)).game;
    await players.friend.goto("/");
    const rooms = players.friend.getByRole("region", { name: "Open rooms", exact: true });
    await expect(rooms).toBeVisible();
    await expect(rooms.getByRole("listitem").filter({ hasText: hostName })).toHaveCount(0);
    const response = await players.friend.request.get("/api/lobbies");
    expect(response.status()).toBe(200);
    const listing = openRoomsSchema.parse(await response.json());
    expect(listing.rooms.map((room) => room.id)).not.toContain(privateRoom.id);
    expect(listing.rooms.map((room) => room.host.displayName)).not.toContain(hostName);
    expect(privateRoom.visibility).toBeUndefined();
    await expect(players.friend.getByLabel("Your display name", { exact: true })).toBeVisible();
    await expect(
      players.friend.getByRole("button", { name: "Change display name", exact: true }),
    ).toHaveCount(0);
  } finally {
    await closePlayers(players);
  }
});

test("a visitor with a stale open room sees a useful error after another player takes its seat", {
  tag: "@three-session-requests",
}, async ({ browser }) => {
  const hostName = uniqueName("Race");
  const players = await createRoom(browser, { visibility: "open", hostName });
  const staleContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  players.contexts.push(staleContext);
  const stale = await staleContext.newPage();
  stale.on("pageerror", (error) => players.pageErrors.push(error.message));
  let releaseListing = () => {};
  const released = new Promise<void>((resolve) => {
    releaseListing = resolve;
  });
  const pattern = /\/api\/lobbies$/;
  const heldListing = async (route: Route) => {
    await released;
    await route.continue();
  };
  try {
    await players.friend.goto("/");
    await stale.goto("/");
    await expect(
      stale
        .getByRole("region", { name: "Open rooms", exact: true })
        .getByRole("listitem")
        .filter({ hasText: hostName }),
    ).toHaveCount(1);
    await stale.route(pattern, heldListing);
    await joinOpenRoom(players.friend, hostName, "First player");
    await expect(
      players.host.getByRole("heading", { name: "Your move", exact: true }),
    ).toBeVisible();
    await joinOpenRoom(stale, hostName, "Late player");
    await expect(stale.getByRole("alert")).toContainText(
      "This open room is no longer available. Choose another room.",
    );
    await expect(stale.getByRole("table", { name: "Chess board" })).toHaveCount(0);
    const joined = await readGame(players.friend);
    expect(joined.game.players.black?.displayName).toBe("First player");
    expect(joined.seat).toBe("black");
  } finally {
    releaseListing();
    await stale.unrouteAll({ behavior: "wait" });
    await closePlayers(players);
  }
});

test("a host cancels room closure from the keyboard and safely retries a lost closing acknowledgement", async ({
  browser,
}, testInfo) => {
  const players = await createRoom(browser, { mobile: true, time: "10+5" });
  const commands: GameCommand[] = [];
  const pattern = /\/api\/games\/[^/]+\/commands$/;
  const handler = async (route: Route) => {
    commands.push(gameCommandSchema.parse(route.request().postDataJSON()));
    if (commands.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  };
  await players.host.route(pattern, handler);
  try {
    const waiting = await readGame(players.host);
    const close = players.host.getByRole("button", { name: "Close room", exact: true });
    await close.focus();
    await players.host.keyboard.press("Enter");
    const confirmation = players.host.getByRole("dialog", {
      name: "Close this room?",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await players.host.screenshot({
      path: testInfo.outputPath("close-room-confirmation-mobile.png"),
      fullPage: true,
    });
    await players.host.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
    await expect(close).toBeFocused();
    expect(commands).toHaveLength(0);
    expect((await readGame(players.host)).game.phase).toBe("waiting");

    await players.host.keyboard.press("Enter");
    await confirmation.getByRole("button", { name: "Keep room open", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(close).toBeFocused();
    expect(commands).toHaveLength(0);
    await players.host.keyboard.press("Enter");
    await confirmation.getByRole("button", { name: "Close room", exact: true }).focus();
    await players.host.keyboard.press("Enter");
    await expect(
      players.host.getByRole("heading", { name: "Room closed", exact: true }),
    ).toBeVisible();
    await expect(
      players.host.getByRole("button", { name: "Retry command", exact: true }),
    ).toBeVisible();
    await expect(confirmation).toHaveCount(0);
    await expect(players.host.getByRole("table", { name: "Chess board" })).toHaveCount(0);
    await expect(
      players.host.getByRole("button", { name: "Request rematch", exact: true }),
    ).toHaveCount(0);
    await expect(players.host.getByRole("button", { name: "Resign", exact: true })).toHaveCount(0);
    const closed = await readGame(players.host);
    expect(closed.game.id).toBe(waiting.game.id);
    expect(closed.game.revision).toBe(waiting.game.revision + 1);
    expect(closed.game.closure).toEqual({ reason: "host-closed", closedAt: expect.any(Number) });
    expect(closed.game.outcome).toBeNull();
    expect(closed.game.position.outcome).toBeNull();
    expect(closed.game.position.moves).toEqual([]);
    expect(closed.game.clocks?.runningColor).toBeNull();

    const acknowledgement = players.host.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        pattern.test(new URL(response.url()).pathname) &&
        response.status() === 200,
    );
    await players.host.getByRole("button", { name: "Retry command", exact: true }).click();
    expect(gameViewSchema.parse(await (await acknowledgement).json()).game.closure).toEqual(
      closed.game.closure,
    );
    await expect(
      players.host.getByRole("button", { name: "Retry command", exact: true }),
    ).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.action).toEqual({ type: "close-room" });
    expect(commands[1]).toEqual(commands[0]);
    expect((await readGame(players.host)).game.revision).toBe(closed.game.revision);
    await players.host.reload();
    await expect(
      players.host.getByRole("heading", { name: "Room closed", exact: true }),
    ).toBeVisible();
    expect((await readGame(players.host)).game.closure).toEqual(closed.game.closure);
    expect(
      await players.host.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await players.host.screenshot({
      path: testInfo.outputPath("closed-private-room-mobile.png"),
      fullPage: true,
    });

    await players.friend.goto(players.invitation);
    await players.friend.getByLabel("Your display name").fill("Late friend");
    await players.friend.getByRole("button", { name: "Join private room", exact: true }).click();
    await expect(players.friend.getByRole("alert")).toContainText(
      /invitation.*(expired|used)|closed/i,
    );
    await expect(players.friend.getByRole("table", { name: "Chess board" })).toHaveCount(0);
    expect((await readGame(players.host)).game.players.black).toBeNull();
    await players.host.getByRole("button", { name: "Create another room", exact: true }).click();
    await expect(
      players.host.getByRole("button", { name: "Create private room", exact: true }),
    ).toBeVisible();
    await expect(
      players.host.getByRole("button", { name: "Return to previous room", exact: true }),
    ).toHaveCount(0);
    expect(
      await players.host.evaluate(() => localStorage.getItem("chess-room.current-game")),
    ).toBeNull();
  } finally {
    await players.host.unroute(pattern, handler);
    await closePlayers(players);
  }
});

test("closing an open room removes discovery and rejects a visitor holding its stale card", async ({
  browser,
}, testInfo) => {
  const hostName = uniqueName("Closed");
  const players = await createRoom(browser, { visibility: "open", hostName });
  const pattern = /\/api\/lobbies$/;
  try {
    const waiting = await readGame(players.host);
    await players.friend.goto("/");
    const card = players.friend
      .getByRole("region", { name: "Open rooms", exact: true })
      .getByRole("listitem")
      .filter({ hasText: hostName });
    await expect(card).toHaveCount(1);
    const listingResponse = await players.friend.request.get("/api/lobbies");
    expect(listingResponse.status()).toBe(200);
    const staleListing = JSON.stringify(openRoomsSchema.parse(await listingResponse.json()));
    // Preserve a genuine older discovery snapshot without holding requests
    // beyond the application's fetch deadline while the host closes the room.
    await players.friend.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: staleListing }),
    );
    await players.host.getByRole("button", { name: "Close room", exact: true }).click();
    const confirmation = players.host.getByRole("dialog", {
      name: "Close this room?",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Close room", exact: true }).click();
    await expect(
      players.host.getByRole("heading", { name: "Room closed", exact: true }),
    ).toBeVisible();
    await expect(players.host.getByLabel("Private invitation link", { exact: true })).toHaveCount(
      0,
    );
    await expect(players.host.getByRole("table", { name: "Chess board" })).toHaveCount(0);
    const closed = await readGame(players.host);
    expect(closed.game.visibility).toBe("open");
    expect(closed.game.closure?.reason).toBe("host-closed");
    expect(closed.game.outcome).toBeNull();
    const response = await players.friend.request.get("/api/lobbies");
    expect(response.status()).toBe(200);
    expect(openRoomsSchema.parse(await response.json()).rooms.map((room) => room.id)).not.toContain(
      waiting.game.id,
    );
    await players.host.screenshot({
      path: testInfo.outputPath("closed-open-room.png"),
      fullPage: true,
    });

    await joinOpenRoom(players.friend, hostName, "Late visitor");
    await expect(players.friend.getByRole("alert")).toContainText(
      "This open room is no longer available. Choose another room.",
    );
    await expect(players.friend.getByRole("table", { name: "Chess board" })).toHaveCount(0);
    expect((await readGame(players.host)).game.players.black).toBeNull();
    await players.friend.unrouteAll({ behavior: "wait" });
    await players.friend.getByRole("button", { name: "Refresh open rooms", exact: true }).click();
    await expect(card).toHaveCount(0);
    await players.host.getByRole("button", { name: "Create another room", exact: true }).click();
    await expect(
      players.host.getByRole("button", { name: "Return to previous room", exact: true }),
    ).toHaveCount(0);
    await players.host.getByRole("radio", { name: /Open lobby/ }).check();
    await players.host.getByRole("button", { name: "Create open room", exact: true }).click();
    await expect(
      players.host.getByRole("heading", { name: "Waiting for an opponent", exact: true }),
    ).toBeVisible();
    expect((await readGame(players.host)).game.id).not.toBe(waiting.game.id);
  } finally {
    try {
      if (!players.friend.isClosed()) await players.friend.unrouteAll({ behavior: "wait" });
    } finally {
      await closePlayers(players);
    }
  }
});

test("a friend joining before a held close command starts a game the host cannot cancel", async ({
  browser,
}) => {
  const players = await createRoom(browser);
  const gate = await holdNextCommand(players.host);
  try {
    const waiting = await readGame(players.host);
    await players.host.getByRole("button", { name: "Close room", exact: true }).click();
    const confirmation = players.host.getByRole("dialog", {
      name: "Close this room?",
      exact: true,
    });
    await confirmation.getByRole("button", { name: "Close room", exact: true }).click();
    await gate.requested;
    expect(gate.commands[0]?.action).toEqual({ type: "close-room" });
    await joinRoom(players);
    await expect(confirmation).toHaveCount(0);
    await expect(players.host.getByRole("button", { name: "Close room", exact: true })).toHaveCount(
      0,
    );
    const rejected = players.host.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/games\/[^/]+\/commands$/.test(new URL(response.url()).pathname) &&
        response.status() === 409,
    );
    gate.release();
    await rejected;
    await expect(players.host.getByRole("alert")).toBeVisible();
    const active = await readGame(players.host);
    expect(active.game.id).toBe(waiting.game.id);
    expect(active.game.phase).toBe("active");
    expect(active.game.closure).toBeUndefined();
    expect(active.game.outcome).toBeNull();
    expect(active.game.position.moves).toEqual([]);
    expect(active.game.players.black?.displayName).toBe("Sam");
    await gate.dispose();
    await players.host.getByRole("button", { name: "Dismiss error", exact: true }).click();
    await move(players.host, "e2", "e4");
    await expect(players.friend.locator('[data-square="e4"]')).toHaveAttribute(
      "aria-label",
      /white pawn/,
    );
    expect((await readGame(players.friend)).game.position.moves).toHaveLength(1);
  } finally {
    await gate.dispose();
    await closePlayers(players);
  }
});

test("Cat Chess is the default mode and its refreshed lobby works on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Cat Chess/);
  await expect(page.locator("header").getByRole("link", { name: /Cat Chess/ })).toBeVisible();
  const catMode = page.getByRole("radio", { name: /Cat Chess/ });
  await expect(catMode).toBeChecked();
  await expect(page.getByRole("slider", { name: "Your cat", exact: true })).toHaveValue("25");
  await expect(page.getByRole("slider", { name: "Friend’s cat", exact: true })).toHaveValue("25");
  await page.screenshot({
    path: testInfo.outputPath("cat-chess-lobby-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("radio", { name: /Chaos Cat/ }).check();
  await expect(page.getByRole("slider")).toHaveCount(0);
  const chaosRules = page.getByRole("region", { name: "Chaos Cat rules", exact: true });
  await expect(chaosRules).toBeVisible();
  await expect(chaosRules).toContainText("50%");
  await expect(chaosRules).toContainText("12.5%");
  await expect(chaosRules).toContainText(/king/i);
  await catMode.check();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Create private room", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("cat-chess-lobby-mobile.png"),
    fullPage: true,
  });
  await page.getByLabel("Your display name").fill("Default cat host");
  await page.getByRole("button", { name: "Create private room", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Waiting for your friend", exact: true }),
  ).toBeVisible();
  const room = await readGame(page);
  expect(room.game.rulesetId).toBe("catchess");
  expect(room.game.catchess).toEqual({ white: 25, black: 25 });
  await page.getByRole("button", { name: "Close room", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Close this room?", exact: true })
    .getByRole("button", { name: "Close room", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Room closed", exact: true })).toBeVisible();
});

test("Chaos Cat changes real pieces and both friends see each visit once across reload and rematch", async ({
  browser,
}, testInfo) => {
  const players = await createRoom(browser, { mode: "chaos-cat", mobile: true });
  try {
    await joinRoom(players);
    await expect(
      players.host.getByRole("heading", { name: "Chaos Cat", exact: true }),
    ).toBeVisible();
    await auditCatVisits(players.host);
    await auditCatVisits(players.friend);
    const starting = (await readGame(players.host)).game;
    expect(starting.catchess).toBeUndefined();
    const names = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" } as const;
    for (const [actor, from, to, ply] of [
      ["host", "e2", "e4", 1],
      ["friend", "e7", "e5", 2],
    ] as const) {
      await players[actor].bringToFront();
      await move(players[actor], from, to);
      await expect
        .poll(async () => (await readGame(players[actor])).game.position.moves.length)
        .toBe(ply);
      const next = (await readGame(players[actor])).game;
      const effect = next.position.catEffects?.[ply - 1];
      expect(next.rulesetId).toBe("chaos-cat");
      expect(effect?.piece).toBeTruthy();
      expect(effect?.action).not.toBe("none");
      if (!effect?.piece || !effect.square || effect.action === "none")
        throw new Error("The opening cat effect did not apply.");
      expect(next.position.board.filter((piece) => piece.type === "k")).toHaveLength(2);
      const changedPiece = { square: effect.square, type: effect.piece, color: effect.color };
      if (effect.action === "add") expect(next.position.board).toContainEqual(changedPiece);
      else expect(next.position.board).not.toContainEqual(changedPiece);
      for (const page of [players.host, players.friend]) {
        const visit = page.locator(`[data-cat-ply="${ply}"]`);
        await expect(visit).toHaveAttribute("data-cat-piece", effect.piece);
        await expect(visit).toHaveAttribute("data-cat-action", effect.action);
        await expect(page.locator(".cat-history-effect").nth(ply - 1)).toContainText(
          names[effect.piece],
        );
      }
      await players.host.screenshot({
        path: testInfo.outputPath(`chaos-cat-move-${ply}.png`),
        fullPage: true,
      });
      await expect(players.host.locator(".cat-layer")).toHaveCount(0);
      await expect(players.friend.locator(".cat-layer")).toHaveCount(0);
    }
    for (const page of [players.host, players.friend])
      expect(await page.evaluate(() => Reflect.get(window, "catVisitAudit"))).toEqual(["1", "2"]);
    const committed = (await readGame(players.host)).game;
    await players.host.reload();
    await expect(players.host.locator(".cat-history-effect")).toHaveCount(2);
    await expect(players.host.locator(".cat-layer")).toHaveCount(0);
    expect((await readGame(players.host)).game.position).toEqual(committed.position);
    expect(
      await players.host.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await players.host.getByRole("button", { name: "Resign", exact: true }).click();
    await players.host.getByRole("button", { name: "Resign game", exact: true }).click();
    await players.host.getByRole("button", { name: "Request rematch", exact: true }).click();
    await players.friend.getByRole("button", { name: "Accept rematch", exact: true }).click();
    await players.host.getByRole("button", { name: "Go to rematch", exact: true }).click();
    await expect(
      players.host.getByRole("heading", { name: "Sam’s move", exact: true }),
    ).toBeVisible();
    const rematch = (await readGame(players.host)).game;
    expect(rematch.id).not.toBe(starting.id);
    expect(rematch.rulesetId).toBe("chaos-cat");
    expect(rematch.catchess).toBeUndefined();
    expect(rematch.position.catEffects).toEqual([]);
    expect((await readGame(players.host)).seat).toBe("black");
  } finally {
    await closePlayers(players);
  }
});

test("a Chaos Cat rook theft exposes the king and a real opponent capture wins", async ({
  browser,
}) => {
  const players = await createRoom(browser, { mode: "chaos-cat" });
  try {
    await joinRoom(players);
    const original = await readGame(players.host);
    // This deterministic setup is confined to the local browser-test database.
    // It avoids adding a production endpoint or depending on a rare random theft.
    if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.loadEnvFile(".env");
    const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
    if (
      !databaseUrl ||
      !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("The browser fixture requires a loopback-only test database.");
    const initial = createEngineState("chaos-cat", "k3r3/8/8/8/8/8/P3R3/4K3 w - - 0 1");
    const state = applyEngineMove(initial, { from: "a2", to: "a3" }, "17".padStart(64, "0"));
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    try {
      const result = await pool.query(
        "UPDATE matches SET engine_state=$1::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE id=$2 AND revision=$3 AND status='active' AND ruleset_id='chaos-cat'",
        [JSON.stringify(state), original.game.id, original.game.revision],
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
    await expect(players.host.locator('[data-square="e2"]')).toHaveAttribute("aria-label", /empty/);
    await expect(players.host.locator('[data-square="e1"]')).toHaveAttribute(
      "aria-label",
      /exposed/,
    );
    await expect(players.friend.locator('[data-square="e1"]')).toHaveAttribute(
      "aria-label",
      /exposed/,
    );
    const exposed = (await readGame(players.friend)).game;
    expect(exposed.position.threatenedKings).toEqual(["white"]);
    expect(exposed.outcome).toBeNull();
    await keyboardMove(players.friend, "e8", "e1");
    await expect(
      players.friend.getByRole("heading", { name: "Sam wins", exact: true }),
    ).toBeVisible();
    const finished = (await readGame(players.friend)).game;
    expect(finished.outcome).toEqual({ winner: "black", reason: "king-captured" });
    expect(finished.position.board.filter((piece) => piece.type === "k")).toEqual([
      { square: "a8", type: "k", color: "black" },
    ]);
    expect(finished.position.legalMoves).toEqual([]);
    await expect(
      players.host.getByRole("paragraph").filter({ hasText: /^King captured$/ }),
    ).toBeVisible();
    await players.host.reload();
    await expect(
      players.host.getByRole("paragraph").filter({ hasText: /^King captured$/ }),
    ).toBeVisible();
    expect((await readGame(players.host)).game.outcome).toEqual(finished.outcome);
  } finally {
    await closePlayers(players);
  }
});
