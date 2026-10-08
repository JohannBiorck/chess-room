import { gameViewSchema } from "@chess-room/contracts";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

type Players = {
  host: Page;
  friend: Page;
  contexts: BrowserContext[];
  invitation: string;
  pageErrors: string[];
};

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
    await dialog.getByRole("button", { name: "knight", exact: true }).click();
    await expect(players.friend.locator('[data-square="a8"]')).toHaveAttribute(
      "aria-label",
      /white knight/,
    );
    await expect(players.host.getByRole("cell", { name: "bxa8=N", exact: true })).toBeVisible();
  } finally {
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
    await players.friend.waitForFunction(
      () =>
        document.querySelector('[data-cat-action="remove"]')?.getAttribute("data-cat-phase") ===
        "paw",
      undefined,
      { polling: "raf", timeout: 5000 },
    );
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
