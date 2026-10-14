import { type BrowserContext, expect, type Page } from "@playwright/test";
import { test } from "./fixtures";

async function authenticator(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { session, authenticatorId };
}

async function fullReplayIsVisible(page: Page) {
  const board = page.getByRole("table", { name: "Saved game board" });
  await expect
    .poll(() =>
      board.evaluate((table) => {
        const panel = table.closest(".account-panel");
        const controls = panel?.querySelector(".replay-control-panel");
        if (!panel || !controls) return false;
        const boardRect = table.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return (
          boardRect.top >= controls.getBoundingClientRect().bottom - 1 &&
          boardRect.bottom <= panelRect.bottom + 1
        );
      }),
    )
    .toBe(true);
}

// These tests share the real loopback IP guard with the friends suite. Give
// subsequent files a complete ordinary session window rather than changing it.
test.afterAll(async () => {
  test.setTimeout(75_000);
  await new Promise((resolve) => setTimeout(resolve, 60_050));
});

test("a real passkey imports a guest seat, saves a private replay and signs in on another device", async ({
  browser,
}) => {
  test.setTimeout(80_000);
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const friendContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const otherDevice = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const page = await context.newPage();
    const keys = await authenticator(context, page);
    await page.goto("/");
    await page.getByLabel("Your display name", { exact: true }).fill("Guest cat");
    await page.getByRole("radio", { name: /Standard chess/ }).check();
    await page.getByLabel("Your pieces", { exact: true }).selectOption("white");
    const createdResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/games" && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create private room", exact: true }).click();
    const created = await (await createdResponse).json();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByLabel("Account display name").fill("Saved cat");
    await page.getByRole("button", { name: "Create account with a passkey" }).click();
    await expect(page.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();
    await page.getByRole("button", { name: "I saved my codes" }).click();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Waiting for your friend" })).toBeVisible();
    const active = await (await context.request.get("/api/account/games")).json();
    expect(active.games.map((game: { id: string }) => game.id)).toContain(created.game.id);
    const base = test.info().project.use.baseURL as string;
    const guest = await friendContext.request.post("/api/session", {
      headers: { Origin: base },
      data: { displayName: "Friend cat" },
    });
    expect(guest.ok()).toBe(true);
    const joined = await friendContext.request.post("/api/invitations/join", {
      headers: { Origin: base },
      data: { token: created.invitation.token },
    });
    expect(joined.ok()).toBe(true);
    await expect(page.getByRole("button", { name: /^e2, white pawn/ })).toBeEnabled();
    await page.getByRole("button", { name: /^e2, white pawn/ }).click();
    await page.getByRole("button", { name: /^e4, / }).click();
    await expect(page.getByRole("button", { name: /^e4, white pawn/ })).toBeVisible();
    const state = await (await context.request.get(`/api/games/${created.game.id}`)).json();
    const finished = await context.request.post(`/api/games/${created.game.id}/commands`, {
      headers: { Origin: base },
      data: {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        expectedRevision: state.game.revision,
        action: { type: "resign" },
      },
    });
    expect(finished.ok()).toBe(true);
    await page.getByRole("button", { name: "Account & history", exact: true }).click();
    await page.getByRole("button", { name: "Match history", exact: true }).click();
    await page.getByRole("button", { name: /loss · Friend cat/ }).click();
    await expect(page.getByRole("table", { name: "Saved game board" })).toBeVisible();
    await page.getByRole("button", { name: "Last", exact: true }).click();
    await expect(
      page
        .getByRole("table", { name: "Saved game board" })
        .getByRole("cell", { name: "e4, white pawn", exact: true }),
    ).toBeVisible();
    await fullReplayIsVisible(page);
    const exported = await (
      await context.request.get(`/api/account/history/${created.game.id}/json`)
    ).text();
    expect(exported).not.toContain("catTurns");
    expect(exported).not.toContain("tokenHash");
    expect(exported).toContain("e4");
    await page.screenshot({ path: "work/browser-qa/history-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      )
      .toBe(true);
    await fullReplayIsVisible(page);
    await page.screenshot({ path: "work/browser-qa/history-mobile.png", fullPage: true });
    expect(
      (await friendContext.request.get(`/api/account/history/${created.game.id}`)).status(),
    ).toBe(401);

    const credentials = await keys.session.send("WebAuthn.getCredentials", {
      authenticatorId: keys.authenticatorId,
    });
    const second = await otherDevice.newPage();
    let nextKeys = await authenticator(otherDevice, second);
    for (const credential of credentials.credentials)
      await nextKeys.session.send("WebAuthn.addCredential", {
        authenticatorId: nextKeys.authenticatorId,
        credential,
      });
    await second.goto("/");
    await second.getByRole("button", { name: "Sign in", exact: true }).click();
    await second.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(second.getByText("Signed in as", { exact: false })).toBeVisible();
    const history = await (await otherDevice.request.get("/api/account/history")).json();
    expect(history.games.map((game: { id: string }) => game.id)).toContain(created.game.id);
    // A second passkey uses a distinct authenticator. Keep the existing one for
    // reauthentication, then attach the new device before registration begins.
    await second.route("**/api/auth/add-passkey/options", async (route) => {
      const response = await route.fetch();
      await nextKeys.session.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId: nextKeys.authenticatorId,
      });
      nextKeys = await authenticator(otherDevice, second);
      await route.fulfill({ response });
    });
    await second.getByRole("button", { name: "Add another passkey", exact: true }).click();
    await expect(second.getByRole("button", { name: "Remove", exact: true })).toHaveCount(2);
    const signedOut = second.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/logout" &&
        response.request().method() === "POST",
    );
    await second.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await signedOut).ok()).toBe(true);
    await expect(second.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    expect((await otherDevice.request.get("/api/account/history")).status()).toBe(401);
    await second.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(second.getByRole("button", { name: "Delete account", exact: true })).toBeVisible();
    await second.getByRole("button", { name: "Delete account", exact: true }).click();
    const deleted = second.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/account" &&
        response.request().method() === "DELETE",
    );
    await second.getByRole("button", { name: "Verify and permanently delete account" }).click();
    expect((await deleted).ok()).toBe(true);
    await expect(second.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    expect((await context.request.get("/api/account/history")).status()).toBe(401);
    const opponentView = await (
      await friendContext.request.get(`/api/games/${created.game.id}`)
    ).json();
    expect(opponentView.game.players.white.displayName).toBe("Deleted player");
  } finally {
    await Promise.all([context.close(), friendContext.close(), otherDevice.close()]);
  }
});

test("Cat Bot computes a real legal turn, reloads safely and rematches", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Play the cat", exact: true }).click();
  await page.getByLabel("Your display name", { exact: true }).fill("Bot challenger");
  await page.getByLabel("Game mode", { exact: true }).selectOption("catchess");
  for (const name of ["Your cat", "Cat Bot’s cat"]) {
    const slider = page.getByRole("slider", { name, exact: true });
    await slider.focus();
    await slider.press("Home");
    for (let step = 0; step < 100; step += 1) await slider.press("ArrowRight");
  }
  await page.getByLabel("Your pieces", { exact: true }).selectOption("black");
  await page.getByLabel("Cat’s thinking", { exact: true }).selectOption("balanced");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/bot-games" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Play the cat", exact: true }).last().click();
  const game = await (await created).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/games/${game.game.id}`)).json()).game.position.moves
          .length,
    )
    .toBe(1);
  await page.reload();
  await expect(page.getByRole("table", { name: /Chess board/ })).toBeVisible();
  const current = await (await page.request.get(`/api/games/${game.game.id}`)).json();
  expect(current.game.position.moves).toHaveLength(1);
  const move = current.game.position.legalMoves[0];
  await page.getByRole("button", { name: new RegExp(`^${move.from}, `) }).click();
  await page.getByRole("button", { name: new RegExp(`^${move.to}, `) }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/games/${game.game.id}`)).json()).game.position.moves
          .length,
    )
    .toBe(3);
  // A friends room replaces the local last-room pointer. The server still
  // exposes this owner's unfinished bot game for recovery from the lobby.
  await page.getByRole("link", { name: /Cat Chess/ }).click();
  await page.getByRole("radio", { name: /Standard chess/ }).check();
  const friendRoomResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/games" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create private room", exact: true }).click();
  const friendRoom = await (await friendRoomResponse).json();
  await expect(page.getByRole("heading", { name: "Waiting for your friend" })).toBeVisible();
  await page.getByRole("link", { name: /Cat Chess/ }).click();
  await page.getByRole("button", { name: "Play the cat", exact: true }).click();
  await page.getByRole("button", { name: "Return to your cat game", exact: true }).click();
  await expect(page.getByRole("table", { name: /Chess board/ })).toBeVisible();
  expect((await (await page.request.get("/api/bot-game")).json()).gameId).toBe(game.game.id);
  await page.screenshot({ path: "work/browser-qa/bot-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await page.screenshot({ path: "work/browser-qa/bot-mobile.png", fullPage: true });
  await page.request.post(`/api/games/${friendRoom.game.id}/commands`, {
    headers: { Origin: test.info().project.use.baseURL as string },
    data: {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      expectedRevision: friendRoom.game.revision,
      action: { type: "close-room" },
    },
  });
  const after = await (await page.request.get(`/api/games/${game.game.id}`)).json();
  const base = test.info().project.use.baseURL as string;
  expect(
    (
      await page.request.post(`/api/games/${game.game.id}/commands`, {
        headers: { Origin: base },
        data: {
          protocolVersion: 1,
          commandId: crypto.randomUUID(),
          expectedRevision: after.game.revision,
          action: { type: "resign" },
        },
      })
    ).ok(),
  ).toBe(true);
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/games/${game.game.id}`)).json()).game.phase,
    )
    .toBe("finished");
  const finished = await (await page.request.get(`/api/games/${game.game.id}`)).json();
  const rematch = await (
    await page.request.post(`/api/games/${game.game.id}/commands`, {
      headers: { Origin: base },
      data: {
        protocolVersion: 1,
        commandId: crypto.randomUUID(),
        expectedRevision: finished.game.revision,
        action: { type: "request-rematch" },
      },
    })
  ).json();
  expect(rematch.game.rematchGameId).toBeTruthy();
  const next = await (await page.request.get(`/api/games/${rematch.game.rematchGameId}`)).json();
  expect(next.seat).toBe("white");
  expect(next.game.bot.color).toBe("black");
  await page.request.post(`/api/games/${next.game.id}/commands`, {
    headers: { Origin: base },
    data: {
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      expectedRevision: next.game.revision,
      action: { type: "resign" },
    },
  });
});
