import { type GameCommand, gameCommandSchema, gameViewSchema } from "@chess-room/contracts";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  type Route,
  test,
  type WebSocketRoute,
} from "@playwright/test";

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

test.beforeEach(async ({ browser: _browser }, testInfo) => {
  // Two guest sessions per room, with spare capacity for the stranger test.
  // A replacement worker cannot remember the previous worker's reservations.
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
    if (sessionReservations.length + 2 <= SESSION_BUDGET) {
      sessionReservations.push(now, now);
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
  sessionReservations.splice(-2, 2, completedAt, completedAt);
});

async function createRoom(
  browser: Browser,
  options: {
    mode?: "standard" | "three-check" | "catchess";
    time?: string;
    mobile?: boolean;
    cats?: { host: number; guest: number };
    reducedMotion?: "reduce" | "no-preference";
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
  await host.getByLabel("Your display name").fill("Alex");
  await host.getByLabel("Your pieces").selectOption("white");
  if (options.mode)
    await host
      .getByRole("radio", {
        name:
          options.mode === "standard"
            ? /Standard chess/
            : options.mode === "three-check"
              ? /Three-check/
              : /Catchess/,
      })
      .check();
  if (options.cats) {
    await setCatChance(host, "Your cat", options.cats.host);
    await setCatChance(host, "Friend’s cat", options.cats.guest);
  }
  if (options.time) await host.getByLabel("Time control").selectOption(options.time);
  await host.getByRole("button", { name: "Create private room" }).click();
  await expect(host.getByRole("heading", { name: "Waiting for your friend" })).toBeVisible();
  const invitation = await host.getByLabel("Private invitation link").inputValue();
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

test("a lost command acknowledgement retries the same command without applying the move twice", async ({
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
    await players.host.getByRole("button", { name: "Retry command" }).click();
    await expect(players.host.getByRole("alert")).toHaveCount(0);
    await expect(players.host.getByText("1 move", { exact: true })).toBeVisible();
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
    await expect(players.friend.getByText("Checkmate", { exact: true })).toBeVisible();
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

test("host refresh recovers invitation safely and completed games reject a consumed invitation", async ({
  browser,
}) => {
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
    await expect(players.friend.getByText("Draw by agreement", { exact: true })).toBeVisible();
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
      players.friend.getByText("Black is in check. Protect the king.", { exact: true }),
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
  await page.getByRole("radio", { name: /Catchess/ }).check();
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
